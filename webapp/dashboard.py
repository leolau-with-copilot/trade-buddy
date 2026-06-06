"""Dashboard data: global economy snapshot + market-moving news.

Backs the webapp's Dashboard tab. The economy snapshot groups the most
market-relevant FRED indicators (rates, inflation, growth, labor, risk) into
cards with a value, as-of date, period change, and a small history for a
sparkline. Market news pulls structured cards from yfinance Search over the
configured macro/world-news queries.

Both degrade gracefully — a failed indicator or news fetch yields a card/list
with nulls rather than raising, so the dashboard always renders.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout, as_completed
from typing import Dict, List

logger = logging.getLogger(__name__)

# Short-lived TTL caches so the dashboard's two slow, live endpoints (economy via
# FRED, news via Finnhub/Yahoo/CCTV) aren't re-fetched on every page load. Warmed
# at server startup (see ``prewarm_dashboard``) so the first load is instant.
_ECONOMY_TTL = 600   # FRED indicators move at most daily
_NEWS_TTL = 180      # headlines refresh every few minutes
_NEWS_DEADLINE = 8.0  # max wall-clock to wait on all news sources before returning
_economy_cache: Dict[str, object] = {"data": None, "ts": 0.0}
_news_cache: Dict[tuple, tuple] = {}   # (symbol, limit) -> (ts, cards)
_cache_lock = threading.Lock()

# Indicator cards grouped by theme. (alias, display label, unit hint, lower_is_better)
# ``unit`` drives client-side formatting; ``good_down`` flags series where a fall
# is market-positive (inflation, unemployment, spreads, VIX) for color coding.
ECONOMY_GROUPS: Dict[str, List[dict]] = {
    "Interest rates": [
        {"alias": "fed_funds", "label": "Fed Funds Rate", "unit": "%"},
        {"alias": "10y_treasury", "label": "10Y Treasury", "unit": "%"},
        {"alias": "2y_treasury", "label": "2Y Treasury", "unit": "%"},
        {"alias": "10y_2y_spread", "label": "10Y–2Y Spread", "unit": "pp"},
    ],
    "Inflation": [
        {"alias": "cpi", "label": "CPI (index)", "unit": "idx", "good_down": True},
        {"alias": "core_cpi", "label": "Core CPI (index)", "unit": "idx", "good_down": True},
        {"alias": "core_pce", "label": "Core PCE (index)", "unit": "idx", "good_down": True},
        {"alias": "breakeven_10y", "label": "10Y Breakeven", "unit": "%", "good_down": True},
    ],
    "Growth & labor": [
        {"alias": "gdp", "label": "Real GDP", "unit": "bn"},
        {"alias": "unemployment", "label": "Unemployment", "unit": "%", "good_down": True},
        {"alias": "nonfarm_payrolls", "label": "Nonfarm Payrolls", "unit": "k"},
        {"alias": "industrial_production", "label": "Industrial Prod.", "unit": "idx"},
    ],
    "Markets & risk": [
        {"alias": "vix", "label": "VIX", "unit": "", "good_down": True},
        {"alias": "high_yield_spread", "label": "HY Spread", "unit": "%", "good_down": True},
        {"alias": "wti_oil", "label": "WTI Crude", "unit": "$"},
        {"alias": "dollar_index", "label": "USD Index", "unit": "idx"},
    ],
}


# Per-card FRED budget (tighter than the 20s default so one slow series doesn't
# stall a worker) and an overall deadline across the whole batch.
_CARD_TIMEOUT = 8
_ECONOMY_DEADLINE = 12.0


def _one_card(spec: dict) -> dict:
    from tradingagents.dataflows.macro_utils import indicator_latest

    try:
        data = indicator_latest(spec["alias"], timeout=_CARD_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 — degrade to an empty card
        # Handled (empty card) + summarised once below, so keep this quiet.
        logger.debug("economy card %s failed: %s", spec["alias"], exc)
        data = {"value": None, "as_of": None, "change": None,
                "pct_change": None, "history": [], "series": spec["alias"]}
    return {
        "alias": spec["alias"],
        "label": spec["label"],
        "unit": spec.get("unit", ""),
        "good_down": bool(spec.get("good_down", False)),
        "series": data.get("series"),
        "value": data.get("value"),
        "as_of": data.get("as_of"),
        "change": data.get("change"),
        "pct_change": data.get("pct_change"),
        "history": data.get("history", []),
    }


def economy_snapshot() -> Dict[str, List[dict]]:
    """Cached ``{group: [card, …]}`` for the economy section.

    The underlying FRED fetch (~9s cold) is memoised for ``_ECONOMY_TTL`` so only
    the first request after the cache expires pays for it.
    """
    now = time.time()
    cached = _economy_cache.get("data")
    if cached is not None and now - float(_economy_cache.get("ts", 0)) < _ECONOMY_TTL:
        return cached  # type: ignore[return-value]
    data = _economy_snapshot_uncached()
    with _cache_lock:
        _economy_cache.update(data=data, ts=now)
    return data


def _economy_snapshot_uncached() -> Dict[str, List[dict]]:
    """Fetch all economy cards live (concurrent FRED calls)."""
    specs = [(group, spec) for group, items in ECONOMY_GROUPS.items() for spec in items]
    results: Dict[str, List[dict]] = {g: [] for g in ECONOMY_GROUPS}
    ordered: Dict[int, tuple] = {}

    # One worker per card: all FRED calls fire at once, so the cold fetch is
    # bounded by a single per-request timeout (~8s) instead of stacking waves.
    with ThreadPoolExecutor(max_workers=max(1, len(specs))) as pool:
        futs = {pool.submit(_one_card, spec): (i, group, spec)
                for i, (group, spec) in enumerate(specs)}
        try:
            for fut in as_completed(futs, timeout=_ECONOMY_DEADLINE):
                i, group, _ = futs[fut]
                ordered[i] = (group, fut.result())
        except FuturesTimeout:
            pool.shutdown(wait=False, cancel_futures=True)
        # Any card that didn't make the deadline degrades to an empty card.
        for fut, (i, group, spec) in futs.items():
            if i not in ordered:
                ordered[i] = (group, {
                    "alias": spec["alias"], "label": spec["label"],
                    "unit": spec.get("unit", ""), "good_down": bool(spec.get("good_down", False)),
                    "series": spec["alias"], "value": None, "as_of": None,
                    "change": None, "pct_change": None, "history": []})

    n_bad = sum(1 for _, c in ordered.values() if c.get("value") is None)
    if n_bad:
        logger.warning("economy snapshot: %d/%d FRED cards unavailable (cached; "
                       "set FRED_API_KEY for the faster JSON API)", n_bad, len(specs))
    for i in sorted(ordered):
        group, card = ordered[i]
        results[group].append(card)
    return results


import contextlib
import os
from datetime import date, datetime, timedelta


# Publishers whose article images render poorly in the card — show a uniformly
# sized brand logo (object-fit: contain) instead. Matched against source/origin.
# Order matters: publisher-specific logos win over the generic Yahoo fallback,
# so a Reuters/Investing.com article (even when aggregated via Yahoo) gets its
# own brand logo rather than the Yahoo logo.
_SOURCE_LOGOS = (
    (("reuters",), "/static/reuter.png"),
    (("investing",), "/static/investing_com.jpeg"),
    (("yahoo", "yfinance"), "/static/yfinance.png"),
)


def _logo_for(source: str, origin: str) -> str:
    s = f"{source} {origin}".lower()
    for keys, path in _SOURCE_LOGOS:
        if any(k in s for k in keys):
            return path
    return ""


# Map common publisher *names* (Finnhub/CCTV give names, not domains) to their
# domain so we can show the publisher's own favicon. Finviz already reports the
# domain directly, so any "x.com"-looking source is used as-is.
_PUBLISHER_DOMAINS = {
    "cnbc": "cnbc.com",
    "bloomberg": "bloomberg.com",
    "wall street journal": "wsj.com",
    "the wall street journal": "wsj.com",
    "financial times": "ft.com",
    "marketwatch": "marketwatch.com",
    "barron's": "barrons.com",
    "barrons": "barrons.com",
    "the motley fool": "fool.com",
    "motley fool": "fool.com",
    "seeking alpha": "seekingalpha.com",
    "business insider": "businessinsider.com",
    "insider monkey": "insidermonkey.com",
    "forbes": "forbes.com",
    "the new york times": "nytimes.com",
    "new york times": "nytimes.com",
    "cnn": "cnn.com",
    "associated press": "apnews.com",
    "ap": "apnews.com",
    "the guardian": "theguardian.com",
    "zerohedge": "zerohedge.com",
    "benzinga": "benzinga.com",
    "thestreet": "thestreet.com",
    "cctv": "cctv.com",
    "fortune": "fortune.com",
    "the economist": "economist.com",
}


def _favicon(source: str) -> str:
    """A publisher's own brand favicon for cards that ship no article image.

    Beats the generic 📰 placeholder — Bloomberg, WSJ, NYT, etc. each get their
    own logo. Uses DuckDuckGo's icon service (high-res, no key, CORS-friendly).
    """
    s = (source or "").strip().lower()
    if not s:
        return ""
    domain = _PUBLISHER_DOMAINS.get(s)
    if not domain and "." in s and " " not in s:
        domain = s  # finviz sources are already bare domains (e.g. "bloomberg.com")
    if not domain:
        return ""
    return f"https://icons.duckduckgo.com/ip3/{domain}.ico"


import functools


@functools.lru_cache(maxsize=1)
def _symbol_names() -> dict:
    """``{SYMBOL: company name}`` for US listings, used to validate ticker tags."""
    try:
        from webapp.markets import us_symbol_list

        return {r["symbol"].upper(): (r.get("name") or "") for r in us_symbol_list()}
    except Exception:  # noqa: BLE001
        return {}


def _verify_tickers(tickers, title: str, summary: str) -> list:
    """Keep only ticker tags actually supported by the headline text.

    Sources (Finnhub ``related``, yfinance fuzzy search) over-tag — they attach a
    symbol to articles that never mention the company. We keep a tag only if the
    symbol itself, or the leading word of its company name (e.g. "Apple" for
    AAPL), appears in the title/summary. This removes spurious "AAPL"-tagged news
    that has nothing to do with Apple.
    """
    text = f"{title} {summary}".lower()
    if not text.strip():
        return []
    names = _symbol_names()
    out = []
    for t in (tickers or []):
        if not t:
            continue
        t = t.upper()
        name = names.get(t, "")
        # leading company-name token, minus a generic "The " prefix
        lead = name[4:] if name.lower().startswith("the ") else name
        lead = lead.split(",")[0].split(" ")[0].strip().lower()
        if t.lower() in text or (len(lead) >= 3 and lead in text):
            out.append(t)
    return out


# Keyword buckets for the live-tape IMPACT column (HIGH/MEDIUM/LOW), à la a
# Bloomberg news terminal. Matched against the headline; SEC filings and
# central-bank/earnings language are treated as market-moving (HIGH).
_IMPACT_HIGH = (
    "earnings", "beats", "misses", "guidance", "downgrade", "upgrade", "acquisition",
    "merger", "acquire", "lawsuit", "sec ", "fda", "recall", "bankruptcy", "default",
    "rate cut", "rate hike", "fed ", "fomc", "inflation", "cpi", "jobs report",
    "payrolls", "tariff", "halt", "investigation", "surge", "plunge", "crash",
    "8-k", "material event", "10-k", "10-q", "dividend", "buyback", "split",
)
_IMPACT_MEDIUM = (
    "analyst", "price target", "outlook", "partnership", "launch", "unveil",
    "expands", "forecast", "rating", "stake", "insider", "deal", "contract",
    "revenue", "profit", "loss", "demand", "supply",
)


def _impact(title: str, origin: str) -> str:
    """Classify a headline's market impact for the live tape: high|medium|low."""
    t = (title or "").lower()
    if origin == "sec" or any(k in t for k in _IMPACT_HIGH):
        return "high"
    if any(k in t for k in _IMPACT_MEDIUM):
        return "medium"
    return "low"


def _card(title, source, published, link, thumbnail="", tickers=None, summary="",
          origin="", contain=False):
    tickers = _verify_tickers(tickers, title, summary)
    logo = _logo_for(source, origin)
    if logo:  # swap oversized/odd publisher images for a consistent brand logo
        thumbnail, contain = logo, True
    elif not thumbnail:  # no article image → use the publisher's own favicon
        fav = _favicon(source)
        if fav:
            thumbnail, contain = fav, True
    return {
        "title": title, "source": source or "", "published": int(published or 0),
        "link": link or "", "thumbnail": thumbnail or "", "tickers": tickers,
        "summary": (summary or "").strip(),
        "origin": origin,          # vendor family (used for source logos)
        "contain": bool(contain),  # render the thumbnail as a contained logo
        "impact": _impact(title, origin),  # high|medium|low — live-tape badge
    }


def _finnhub_news_cards(symbol: str | None, limit: int) -> List[dict]:
    """Finnhub general market news, or company-news when ``symbol`` is given."""
    token = os.environ.get("FINNHUB_API_KEY")
    if not token:
        return []
    import requests
    try:
        if symbol:
            end = date.today(); start = end - timedelta(days=14)
            r = requests.get("https://finnhub.io/api/v1/company-news",
                             params={"symbol": symbol.upper(), "from": start.isoformat(),
                                     "to": end.isoformat(), "token": token}, timeout=15)
        else:
            r = requests.get("https://finnhub.io/api/v1/news",
                             params={"category": "general", "token": token}, timeout=15)
        r.raise_for_status()
        rows = r.json() or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("Finnhub news failed (%s): %s", symbol, exc)
        return []
    cards = []
    for a in rows[: limit * 2]:
        rel = a.get("related") or ""
        tickers = [s for s in str(rel).split(",") if s][:3]
        cards.append(_card(a.get("headline", ""), a.get("source", ""), a.get("datetime", 0),
                           a.get("url", ""), a.get("image", ""), tickers, a.get("summary", ""),
                           origin="finnhub"))
    return cards


def _yf_news_cards(symbol: str | None, limit: int) -> List[dict]:
    """yfinance Search news — by symbol, or over the configured macro queries."""
    import yfinance as yf
    from tradingagents.dataflows.config import get_config
    from tradingagents.dataflows.stockstats_utils import yf_retry

    if symbol:
        queries = [symbol.upper()]
    else:
        try:
            queries = get_config().get("global_news_queries", ["stock market", "federal reserve"])
        except Exception:  # noqa: BLE001
            queries = ["stock market", "federal reserve", "inflation"]
    # Fuzzy matching pulls loosely-related articles; for a specific symbol that
    # produces off-topic, mis-tagged news, so disable it when a symbol is given.
    fuzzy = symbol is None
    cards = []
    for q in queries:
        try:
            search = yf_retry(lambda qq=q: yf.Search(query=qq, news_count=8, enable_fuzzy_query=fuzzy))
            articles = search.news or []
        except Exception as exc:  # noqa: BLE001
            logger.warning("yfinance news query %r failed: %s", q, exc)
            continue
        for a in articles:
            tickers = [symbol.upper()] if symbol else []
            # yfinance's article images are oversized for the card; use the
            # Yahoo Finance logo (contained) as the thumbnail instead.
            cards.append(_card(a.get("title", ""), a.get("publisher", ""),
                               a.get("providerPublishTime", 0), a.get("link", ""),
                               "/static/yfinance.png", tickers, origin="yahoo", contain=True))
    return cards


def _yahoo_rss_news_cards(symbol: str | None, limit: int) -> List[dict]:
    """Yahoo Finance RSS *headline* feed — the source the Whale dashboard used.

    Folded into the main aggregator so its market headlines (ETF milestones,
    macro/geopolitics, single-name moves) surface in the News section. Uses a
    market proxy (SPY) for the macro feed; the symbol itself when filtering.
    """
    import requests
    from email.utils import parsedate_to_datetime

    sym = (symbol or "SPY").upper()
    try:
        r = requests.get(
            f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={sym}&region=US&lang=en-US",
            headers={"User-Agent": "Mozilla/5.0"}, timeout=6,
        )
        r.raise_for_status()
        xml = r.text
    except Exception as exc:  # noqa: BLE001
        logger.warning("yahoo rss news failed: %s", exc)
        return []
    cards = []
    for block in re.findall(r"<item>([\s\S]*?)</item>", xml):
        tm = re.search(r"<title><!\[CDATA\[(.*?)\]\]></title>", block) or re.search(r"<title>(.*?)</title>", block)
        title = tm.group(1).strip() if tm else ""
        if not title:
            continue
        lm = re.search(r"<link>(.*?)</link>", block)
        link = lm.group(1).strip() if lm else ""
        pm = re.search(r"<pubDate>(.*?)</pubDate>", block)
        published = 0
        if pm:
            try:
                published = int(parsedate_to_datetime(pm.group(1).strip()).timestamp())
            except Exception:  # noqa: BLE001
                published = 0
        cards.append(_card(title, "Yahoo Finance", published, link,
                           "/static/yfinance.png", [sym] if symbol else [],
                           origin="yahoo", contain=True))
    return cards[:limit]


def _cctv_news_cards(limit: int = 8) -> List[dict]:
    """China macro/state news (CCTV 新闻联播) via AKShare — macro feed only."""
    try:
        from finnlp.data_sources.news.akshare_cctv import Akshare_cctv
        end = datetime.now(); start = end - timedelta(days=3)
        dl = Akshare_cctv()
        # finnlp loops with a console tqdm bar; redirect stderr to silence it
        # in the server logs (tqdm honors the current sys.stderr).
        with open(os.devnull, "w") as _null, contextlib.redirect_stderr(_null):
            dl.download_news(start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
        df = dl.dataframe
    except Exception as exc:  # noqa: BLE001
        logger.warning("CCTV news failed: %s", exc)
        return []
    if df is None or df.empty:
        return []
    title_col = "title" if "title" in df.columns else df.columns[min(1, len(df.columns) - 1)]
    date_col = "date" if "date" in df.columns else None
    cards = []
    for _, r in df.head(limit).iterrows():
        ts = 0
        if date_col:
            try:
                ts = int(datetime.strptime(str(r[date_col])[:10], "%Y-%m-%d").timestamp())
            except Exception:  # noqa: BLE001
                ts = 0
        cards.append(_card(str(r.get(title_col, "")), "CCTV 新闻联播", ts, "", "", [], "",
                           origin="cctv"))
    return cards


def _finviz_news_cards(symbol: str | None, limit: int) -> List[dict]:
    """Finviz financial news (general front page, or a ticker's headlines)."""
    try:
        from tradingagents.dataflows import finviz_utils
        rows = finviz_utils.fetch_news(symbol, limit)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Finviz news failed (%s): %s", symbol, exc)
        return []
    return [_card(r["title"], r["source"], r["published"], r["link"],
                  r["thumbnail"], r["tickers"], r["summary"], origin="finviz") for r in rows]


def _sec_news_cards(symbol: str | None, limit: int) -> List[dict]:
    """Material SEC filings (8-K events) as news cards — company feed only.

    8-Ks are how companies disclose market-moving events (earnings, M&A, exec
    changes). Free from EDGAR, no key. Skipped for the broad macro feed (would
    require scanning every filer). Tagged HIGH impact in the tape.
    """
    if not symbol:
        return []
    try:
        from tradingagents.dataflows.sec_utils import recent_filings
        rows = recent_filings(symbol, form_type="8-K", limit=max(4, limit // 3))
    except Exception as exc:  # noqa: BLE001
        logger.warning("SEC news failed (%s): %s", symbol, exc)
        return []
    return [_card(r["title"], "SEC EDGAR", r["published"], r["link"],
                  "", r["tickers"], "", origin="sec") for r in rows]


def _tiingo_news_cards(symbol: str | None, limit: int) -> List[dict]:
    """Tiingo news — activates only if TIINGO_API_KEY is set (else a no-op)."""
    token = os.environ.get("TIINGO_API_KEY") or os.environ.get("TIINGO_TOKEN")
    if not token:
        return []
    import requests
    params = {"token": token, "limit": limit}
    if symbol:
        params["tickers"] = symbol.upper()
    try:
        r = requests.get("https://api.tiingo.com/tiingo/news", params=params, timeout=15)
        r.raise_for_status()
        rows = r.json() or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("Tiingo news failed (%s): %s", symbol, exc)
        return []
    cards = []
    for a in rows[:limit]:
        ts = 0
        try:
            from datetime import datetime as _dt
            ts = int(_dt.fromisoformat(str(a.get("publishedDate", "")).replace("Z", "+00:00")).timestamp())
        except Exception:  # noqa: BLE001
            pass
        tickers = [t.upper() for t in (a.get("tickers") or [])][:3]
        cards.append(_card(a.get("title", ""), a.get("source", "Tiingo"), ts,
                           a.get("url", ""), "", tickers, a.get("description", ""),
                           origin="tiingo"))
    return cards


def _fmp_news_cards(symbol: str | None, limit: int) -> List[dict]:
    """FMP news — activates only if FMP_API_KEY is set (else a no-op)."""
    token = os.environ.get("FMP_API_KEY") or os.environ.get("FMP_TOKEN")
    if not token:
        return []
    import requests
    if symbol:
        url = "https://financialmodelingprep.com/api/v3/stock_news"
        params = {"tickers": symbol.upper(), "limit": limit, "apikey": token}
    else:
        url = "https://financialmodelingprep.com/api/v4/general_news"
        params = {"page": 0, "apikey": token}
    try:
        r = requests.get(url, params=params, timeout=15)
        r.raise_for_status()
        rows = r.json() or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("FMP news failed (%s): %s", symbol, exc)
        return []
    cards = []
    for a in rows[:limit]:
        ts = 0
        try:
            from datetime import datetime as _dt
            ts = int(_dt.strptime(a.get("publishedDate", "")[:19], "%Y-%m-%d %H:%M:%S").timestamp())
        except Exception:  # noqa: BLE001
            pass
        sym_tag = [a["symbol"].upper()] if a.get("symbol") else ([symbol.upper()] if symbol else [])
        cards.append(_card(a.get("title", ""), a.get("site", "FMP"), ts,
                           a.get("url", ""), a.get("image", ""), sym_tag,
                           a.get("text", ""), origin="fmp"))
    return cards


def market_news(symbol: str | None = None, limit: int = 24) -> List[dict]:
    """Cached aggregated, de-duplicated, most-recent-first market news.

    Memoised per ``(symbol, limit)`` for ``_NEWS_TTL`` so repeat loads (and the
    broad dashboard feed in particular) don't re-hit every news vendor each time.
    """
    symbol = (symbol or "").strip().upper() or None
    key = (symbol, int(limit))
    now = time.time()
    hit = _news_cache.get(key)
    if hit is not None and now - hit[0] < _NEWS_TTL:
        return hit[1]
    cards = _market_news_uncached(symbol, limit)
    with _cache_lock:
        _news_cache[key] = (now, cards)
    return cards


def _market_news_uncached(symbol: str | None, limit: int) -> List[dict]:
    """Fetch + dedupe news live across all vendors (sources run concurrently)."""

    # Pull each source concurrently so one slow vendor doesn't stall the feed.
    per_source = max(8, limit // 2)
    fetchers = {
        "finnhub": lambda: _finnhub_news_cards(symbol, per_source),
        "yahoo":   lambda: _yf_news_cards(symbol, per_source),
        "yahoorss": lambda: _yahoo_rss_news_cards(symbol, per_source),
        "finviz":  lambda: _finviz_news_cards(symbol, per_source),
        "tiingo":  lambda: _tiingo_news_cards(symbol, per_source),   # key-gated
        "fmp":     lambda: _fmp_news_cards(symbol, per_source),      # key-gated
    }
    if symbol:
        fetchers["sec"] = lambda: _sec_news_cards(symbol, per_source)
    else:
        fetchers["cctv"] = lambda: _cctv_news_cards(8)

    cards: List[dict] = []
    # Bound the whole fetch by a wall-clock deadline: return as soon as the fast
    # sources are in, rather than blocking on the slowest one (CCTV/akshare in
    # particular has no socket timeout and can hang for a minute+). Sources that
    # miss the deadline keep running on their daemon threads but don't stall the
    # response — their results land in the next cache refresh.
    ex = ThreadPoolExecutor(max_workers=len(fetchers))
    futures = {ex.submit(fn): name for name, fn in fetchers.items()}
    try:
        for fut in as_completed(futures, timeout=_NEWS_DEADLINE):
            try:
                cards += fut.result() or []
            except Exception as exc:  # noqa: BLE001
                logger.warning("news source %s failed: %s", futures[fut], exc)
    except FuturesTimeout:
        slow = [n for f, n in futures.items() if not f.done()]
        logger.warning("news fetch hit %.0fs deadline; skipped slow sources: %s",
                       _NEWS_DEADLINE, ", ".join(slow))
    finally:
        # Don't block the response waiting on the stragglers.
        ex.shutdown(wait=False, cancel_futures=True)

    # Dedupe by normalized title; prefer the richer card (one with a thumbnail).
    best: Dict[str, dict] = {}
    for c in cards:
        key = "".join(ch for ch in c["title"].lower() if ch.isalnum())[:80]
        if not key:
            continue
        prev = best.get(key)
        if prev is None or (not prev["thumbnail"] and c["thumbnail"]):
            best[key] = c

    # Strictly newest-first — no importance scoring, just chronological order.
    ordered = sorted(best.values(), key=lambda c: c["published"] or 0, reverse=True)
    return ordered[:limit]


def prewarm_dashboard() -> None:
    """Warm the economy + broad-news caches (call at startup, off the request path).

    Each is best-effort and isolated so a slow/failed vendor can't break boot; the
    first real dashboard load then reads warm caches instead of a ~9s live fetch.
    """
    try:
        economy_snapshot()
    except Exception as exc:  # noqa: BLE001
        logger.warning("economy prewarm failed: %s", exc)
    try:
        # Match the frontend's default broad feed (app.js requests limit=45) so the
        # warmed cache key is exactly the one the first page load asks for.
        market_news(symbol=None, limit=45)
    except Exception as exc:  # noqa: BLE001
        logger.warning("market-news prewarm failed: %s", exc)
