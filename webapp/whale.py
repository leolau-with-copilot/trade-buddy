"""Whale-trading data feeds (ported from the open-source Whale-Watcher app).

A collection of keyless public-API readers powering the dashboard's "Whale
Trading" section. Each function returns a plain dict/list and degrades to a
sensible fallback on any error so the UI always renders. Results are cached
in-process with a short TTL to spare the upstreams (and our request latency).

Sources (all free, no key):
* CNN Fear & Greed, Yahoo Finance (indices/news/earnings), Reddit r/wallstreetbets
* FINRA Reg SHO daily short volume (dark pool proxy)
* SEC EDGAR 13F (famous investors) + arkfunds.io (Cathie Wood, daily)
* QuiverQuant live congressional trading (with a static fallback)
* Blockstream / Blockscout on-chain balances + CoinGecko prices (crypto whales)

Ported from Whale-watcher-master/app/api/*/route.ts.
"""

from __future__ import annotations

import logging
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
_EDGAR_UA = "TradeBuddy WhaleTracker contact@tradebuddy.app"

# ── tiny in-process TTL cache ───────────────────────────────────────────────
_CACHE: Dict[str, tuple] = {}


def _cached(key: str, ttl: float, producer):
    """Return ``producer()`` memoised under ``key`` for ``ttl`` seconds."""
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[1] < ttl:
        return hit[0]
    val = producer()
    _CACHE[key] = (val, now)
    return val


def _get_json(url: str, *, timeout: float = 8.0, headers: Optional[dict] = None):
    h = {"User-Agent": _UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    r = requests.get(url, headers=h, timeout=timeout)
    r.raise_for_status()
    return r.json()


def _get_text(url: str, *, timeout: float = 8.0, headers: Optional[dict] = None) -> str:
    h = {"User-Agent": _UA}
    if headers:
        h.update(headers)
    r = requests.get(url, headers=h, timeout=timeout)
    r.raise_for_status()
    return r.text


# ── Dashboard: Fear & Greed ─────────────────────────────────────────────────
def fear_greed() -> Dict[str, Any]:
    def _f():
        d = _get_json(
            "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
            headers={"Referer": "https://edition.cnn.com/markets/fear-and-greed"},
        )
        fg = d.get("fear_and_greed", {})
        hist = (d.get("fear_and_greed_historical", {}) or {}).get("data", []) or []
        prev = fg.get("score", 50)
        try:
            prev = hist[-8][1]
        except Exception:  # noqa: BLE001
            pass
        return {
            "score": round(fg.get("score", 50)),
            "rating": fg.get("rating", "Neutral"),
            "prev_week": round(prev),
        }

    try:
        return _cached("fg", 300, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("fear_greed failed: %s", exc)
        return {"score": 50, "rating": "Neutral", "prev_week": 50}


# ── Dashboard: live indices ─────────────────────────────────────────────────
_INDEX_SYMBOLS = [
    {"ticker": "SPY", "label": "S&P 500", "type": "index"},
    {"ticker": "QQQ", "label": "NASDAQ", "type": "index"},
    {"ticker": "DIA", "label": "DOW", "type": "index"},
    {"ticker": "BTC-USD", "label": "Bitcoin", "type": "crypto"},
    {"ticker": "ETH-USD", "label": "Ethereum", "type": "crypto"},
    {"ticker": "^VIX", "label": "VIX", "type": "fear"},
]


def _yahoo_quote(ticker: str) -> Dict[str, Any]:
    try:
        url = (
            "https://query2.finance.yahoo.com/v8/finance/chart/"
            f"{requests.utils.quote(ticker)}?interval=1d&range=5d"
        )
        j = _get_json(url, timeout=6)
        meta = (((j.get("chart") or {}).get("result") or [{}])[0] or {}).get("meta", {})
        price = meta.get("regularMarketPrice")
        prev = meta.get("chartPreviousClose") or meta.get("previousClose")
        change = (price - prev) if (price is not None and prev is not None) else None
        pct = (change / prev * 100) if (change is not None and prev) else None
        return {"price": price, "change": change, "changePct": pct}
    except Exception:  # noqa: BLE001
        return {"price": None, "change": None, "changePct": None}


def _yahoo_quote_1d(ticker: str) -> Dict[str, Any]:
    """Daily quote (price vs previous close) — accurate 1-day % for the heatmap."""
    try:
        url = (
            "https://query2.finance.yahoo.com/v8/finance/chart/"
            f"{requests.utils.quote(ticker)}?interval=1d&range=1d&includePrePost=false"
        )
        j = _get_json(url, timeout=6)
        meta = (((j.get("chart") or {}).get("result") or [{}])[0] or {}).get("meta", {})
        price = meta.get("regularMarketPrice")
        if price is None:
            return {"price": None}
        prev = meta.get("chartPreviousClose") or meta.get("previousClose") or price
        change = price - prev
        pct = (change / prev * 100) if prev else 0
        return {"price": price, "change": change, "changePct": pct}
    except Exception:  # noqa: BLE001
        return {"price": None}


# ── Options Flow: Yahoo option chain + Black-Scholes greeks ─────────────────
def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _norm_pdf(x: float) -> float:
    return math.exp(-x * x / 2) / math.sqrt(2 * math.pi)


def _bs_greeks(typ: str, S: float, K: float, T: float, sigma: float, r: float = 0.045):
    """Black-Scholes delta + per-day theta (Yahoo's chain has no greeks)."""
    if not (S and K and T and T > 0 and sigma and sigma > 0):
        return None, None
    d1 = (math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    common = -(S * _norm_pdf(d1) * sigma) / (2 * math.sqrt(T))
    if typ == "call":
        delta = _norm_cdf(d1)
        theta = (common - r * K * math.exp(-r * T) * _norm_cdf(d2)) / 365
    else:
        delta = _norm_cdf(d1) - 1
        theta = (common + r * K * math.exp(-r * T) * _norm_cdf(-d2)) / 365
    return round(delta, 2), round(theta, 3)


def _num(v, default=0.0) -> float:
    """Coerce to float, treating None / NaN / junk as ``default`` (yfinance emits NaN)."""
    try:
        f = float(v)
        return f if f == f else default   # NaN != NaN
    except (TypeError, ValueError):
        return default


def _map_option_row(row, typ: str, S: Optional[float], exp: str, dte: int) -> Optional[Dict[str, Any]]:
    vol = int(_num(row.get("volume")))
    if vol <= 0:
        return None
    oi = int(_num(row.get("openInterest")))
    last = _num(row.get("lastPrice"))
    strike = _num(row.get("strike"))
    iv = _num(row.get("impliedVolatility"))
    itm = bool(row.get("inTheMoney"))
    premium = vol * last * 100
    vol_oi = (vol / oi) if oi > 0 else 0.0
    delta, theta = _bs_greeks(typ, S or 0, strike, dte / 365 if dte > 0 else 0, iv)
    return {
        "type": typ, "strike": strike, "expiry": exp, "dte": dte,
        "lastPrice": round(last, 2), "premium": round(premium),
        "volume": vol, "openInterest": oi, "volOiRatio": round(vol_oi, 2),
        "iv": round(iv * 100, 1), "inTheMoney": itm,
        "unusual": vol_oi > 0.5 and vol > 50,
        "delta": delta, "theta": theta,
    }


def options(ticker: str) -> Dict[str, Any]:
    """Options flow for ``ticker``: nearest-expiry chain, P/C ratio, greeks.

    Uses yfinance (handles Yahoo crumb auth) for the chain; greeks are
    Black-Scholes derived from the live price + Yahoo's implied vol. Cached 120s.
    """
    ticker = (ticker or "").strip().upper()
    if not ticker:
        return {"flow": [], "quote": {}, "putCallRatio": None, "expiry": "", "error": "no ticker"}

    def _f():
        import yfinance as yf
        tk = yf.Ticker(ticker)
        exps = list(tk.options or [])
        if not exps:
            return {"flow": [], "quote": {"symbol": ticker}, "putCallRatio": None,
                    "totalCallVol": 0, "totalPutVol": 0, "unusual": 0, "expiry": "",
                    "expirations": [], "source": "yahoo", "note": "No listed options."}
        # Skip 0DTE/same-week noise (open interest is ~0, greeks undefined); pick
        # the first expiry at least a week out, like a standard flow view.
        exp = next((e for e in exps if (date.fromisoformat(e) - date.today()).days >= 7), exps[0])
        dte = max(0, (date.fromisoformat(exp) - date.today()).days)
        # Live underlying price + day change.
        price = prev = None
        try:
            fi = tk.fast_info
            price = float(fi.last_price) if fi.last_price is not None else None
            prev = float(fi.previous_close) if fi.previous_close is not None else None
        except Exception:  # noqa: BLE001
            pass
        chain = tk.option_chain(exp)
        calls = [r for r in (_map_option_row(d, "call", price, exp, dte) for d in chain.calls.to_dict("records")) if r]
        puts = [r for r in (_map_option_row(d, "put", price, exp, dte) for d in chain.puts.to_dict("records")) if r]
        total_call_vol = sum(c["volume"] for c in calls)
        total_put_vol = sum(p["volume"] for p in puts)
        flow = sorted(calls + puts, key=lambda c: c["premium"], reverse=True)[:80]
        change = (price - prev) if (price is not None and prev is not None) else None
        return {
            "quote": {
                "symbol": ticker, "price": round(price, 2) if price is not None else None,
                "change": round(change, 2) if change is not None else None,
                "changePct": round(change / prev * 100, 2) if (change is not None and prev) else None,
            },
            "flow": flow,
            "putCallRatio": round(total_put_vol / total_call_vol, 2) if total_call_vol else None,
            "totalCallVol": total_call_vol, "totalPutVol": total_put_vol,
            "unusual": sum(1 for c in flow if c["unusual"]),
            "expiry": exp, "dte": dte, "expirations": exps[:12], "source": "yahoo",
        }

    try:
        return _cached(f"options:{ticker}", 120, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("options(%s) failed: %s", ticker, exc)
        return {"flow": [], "quote": {"symbol": ticker}, "putCallRatio": None,
                "totalCallVol": 0, "totalPutVol": 0, "unusual": 0, "expiry": "",
                "expirations": [], "source": "yahoo", "error": str(exc)}


def stocks(tickers: List[str]) -> Dict[str, Any]:
    """Batch daily quotes for the heatmap via Yahoo's ``spark`` endpoint.

    ONE request resolves the whole chunk (~0.7s) instead of one chart call per
    ticker (~6s for 30). Returns ``{quotes: {ticker: {price, change, changePct}}}``;
    tickers Yahoo can't resolve are omitted (the cell renders blank). 20s cache.
    """
    tickers = [t for t in tickers if t][:60]
    if not tickers:
        return {"quotes": {}}

    def _spark_chunk(chunk: List[str]) -> Dict[str, dict]:
        """One spark call for up to ~10 symbols (Yahoo 400s on long lists)."""
        url = (
            "https://query1.finance.yahoo.com/v8/finance/spark?symbols="
            f"{requests.utils.quote(','.join(chunk))}&range=1d&interval=1d"
        )
        j = _get_json(url, timeout=8)
        rows: Dict[str, dict] = {}
        # Yahoo returns either a flat {symbol: {...}} map or the older
        # {"spark": {"result": [{symbol, response:[{meta, indicators}]}]}}.
        if isinstance(j.get("spark"), dict):
            for it in (j["spark"].get("result") or []):
                resp = (it.get("response") or [{}])[0]
                meta = resp.get("meta", {})
                closes = ((resp.get("indicators", {}).get("quote", [{}]) or [{}])[0]).get("close") or []
                rows[it.get("symbol")] = {"close": closes,
                                          "prev": meta.get("chartPreviousClose") or meta.get("previousClose"),
                                          "price": meta.get("regularMarketPrice")}
        else:
            for sym, d in j.items():
                if isinstance(d, dict) and ("close" in d or "chartPreviousClose" in d):
                    rows[sym] = {"close": d.get("close") or [],
                                 "prev": d.get("chartPreviousClose") or d.get("previousClose"),
                                 "price": d.get("regularMarketPrice")}
        return rows

    def _f():
        sub = [tickers[i:i + 10] for i in range(0, len(tickers), 10)]
        rows: Dict[str, dict] = {}
        with ThreadPoolExecutor(max_workers=min(8, len(sub))) as ex:
            futs = [ex.submit(_spark_chunk, c) for c in sub]
            for fut in as_completed(futs):
                try:
                    rows.update(fut.result())
                except Exception:  # noqa: BLE001
                    pass
        quotes: Dict[str, Any] = {}
        for sym in tickers:
            d = rows.get(sym)
            if not d:
                continue
            closes = [c for c in (d.get("close") or []) if c is not None]
            price = closes[-1] if closes else d.get("price")
            prev = d.get("prev")
            if price is None or not prev:
                continue
            change = price - prev
            quotes[sym] = {"price": round(price, 4), "change": round(change, 2),
                           "changePct": round(change / prev * 100, 2)}
        return {"quotes": quotes}

    try:
        return _cached("stocks:" + ",".join(sorted(tickers)), 20, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("stocks failed: %s", exc)
        return {"quotes": {}}


def indices() -> Dict[str, Any]:
    def _f():
        out = []
        with ThreadPoolExecutor(max_workers=len(_INDEX_SYMBOLS)) as ex:
            futs = {ex.submit(_yahoo_quote, s["ticker"]): s for s in _INDEX_SYMBOLS}
            for fut in as_completed(futs):
                s = futs[fut]
                try:
                    out.append({**s, **fut.result()})
                except Exception:  # noqa: BLE001
                    out.append({**s, "price": None, "change": None, "changePct": None})
        order = {s["ticker"]: i for i, s in enumerate(_INDEX_SYMBOLS)}
        out.sort(key=lambda r: order.get(r["ticker"], 99))
        return {"indices": out}

    try:
        return _cached("indices", 30, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("indices failed: %s", exc)
        return {"indices": []}


# ── Dashboard: WSB trending ─────────────────────────────────────────────────
_WSB_STOP = {
    "I", "A", "THE", "AND", "OR", "IN", "AT", "FOR", "TO", "IS", "ARE", "WAS", "BE",
    "HAS", "WE", "MY", "BY", "ITS", "ALL", "SO", "IF", "ON", "DO", "UP", "IT", "OF",
    "AS", "AN", "AM", "PM", "AI", "CEO", "CFO", "US", "DD", "OP", "OG", "IMO", "ATH",
    "YTD", "IPO", "EPS", "GDP", "CPI", "ETF", "SEC", "FDA", "FED", "WSB", "YOLO",
    "FOMO", "GET", "BUY", "SELL", "HOLD", "PUT", "CALL", "RIP", "WTF", "LOL", "LMAO",
}


def _extract_tickers(text: str) -> List[str]:
    freq: Dict[str, int] = {}
    for t in re.findall(r"\b[A-Z]{1,5}\b", text):
        if len(t) >= 2 and t not in _WSB_STOP:
            freq[t] = freq.get(t, 0) + 1
    return [t for t, _ in sorted(freq.items(), key=lambda kv: -kv[1])[:8]]


def wsb() -> Dict[str, Any]:
    def _f():
        # Reddit blocks data-center IPs/default UAs; try a few host+UA combos.
        j = None
        for host, ua in (
            ("https://www.reddit.com", _UA),
            ("https://old.reddit.com", _UA),
            ("https://www.reddit.com", "WhaleWatcher/1.0"),
        ):
            try:
                j = _get_json(f"{host}/r/wallstreetbets/hot.json?limit=50",
                              headers={"User-Agent": ua}, timeout=6)
                break
            except Exception:  # noqa: BLE001
                continue
        if not j:
            raise RuntimeError("reddit blocked")
        posts = [
            {
                "title": c["data"]["title"],
                "score": c["data"]["score"],
                "url": f"https://reddit.com{c['data']['permalink']}",
            }
            for c in j["data"]["children"]
        ]
        tickers = _extract_tickers(" ".join(p["title"] for p in posts))
        return {"tickers": tickers, "topPosts": posts[:5]}

    try:
        return _cached("wsb", 60, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("wsb failed: %s", exc)
        return {"tickers": [], "topPosts": []}


# ── Dashboard: ticker news (Yahoo RSS) ──────────────────────────────────────
def news(ticker: str = "SPY") -> Dict[str, Any]:
    ticker = (ticker or "SPY").strip().upper()

    def _f():
        xml = _get_text(
            "https://feeds.finance.yahoo.com/rss/2.0/headline?s="
            f"{requests.utils.quote(ticker)}&region=US&lang=en-US",
            timeout=6,
        )
        items = []
        for block in re.findall(r"<item>([\s\S]*?)</item>", xml):
            title = (
                (re.search(r"<title><!\[CDATA\[(.*?)\]\]></title>", block) or [None, None])[1]
                if "CDATA" in block else None
            ) or (re.search(r"<title>(.*?)</title>", block) or [None, ""])[1]
            link = (re.search(r"<link>(.*?)</link>", block) or [None, ""])[1]
            pub = (re.search(r"<pubDate>(.*?)</pubDate>", block) or [None, ""])[1]
            if title:
                items.append({"title": title.strip(), "link": link.strip(), "pubDate": pub.strip()})
        return {"items": items[:12]}

    try:
        return _cached(f"news:{ticker}", 120, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("news failed: %s", exc)
        return {"items": []}


# ── Dark Pool: FINRA Reg SHO short volume ───────────────────────────────────
def _prev_business_days(n: int) -> List[str]:
    out, d = [], datetime.utcnow()
    while len(out) < n:
        d -= timedelta(days=1)
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.strftime("%Y%m%d"))
    return out


def _to_int(v: str) -> int:
    """Coerce a FINRA numeric field to int (the feed now emits floats)."""
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _finra_day_all(date_str: str) -> Dict[str, Dict[str, int]]:
    """Download + parse one FINRA Reg SHO daily file → ``{symbol: {short, exempt, total}}``.

    Cached for the day (the file is immutable once posted) so the top-150 list, a
    single-ticker lookup, and the multi-day history all share a single download.
    """
    def _f() -> Dict[str, Dict[str, int]]:
        url = f"https://cdn.finra.org/equity/regsho/daily/CNMSshvol{date_str}.txt"
        text = _get_text(url, timeout=10)
        out: Dict[str, Dict[str, int]] = {}
        for line in text.splitlines()[1:]:
            parts = line.strip().split("|")
            if len(parts) < 5:
                continue
            symbol = (parts[1] or "").strip().upper()
            if not symbol or re.search(r"[^A-Z]", symbol):
                continue
            out[symbol] = {
                "short": _to_int(parts[2]),
                "exempt": _to_int(parts[3]),
                "total": _to_int(parts[4]),
            }
        return out

    return _cached(f"finra_all:{date_str}", 6 * 3600, _f)


def _dp_entry(symbol: str, raw: Dict[str, int], date_str: str) -> Dict[str, Any]:
    short_vol, total_vol = raw["short"], raw["total"]
    short_pct = (short_vol / total_vol * 100) if total_vol else 0
    signal = "bullish" if short_pct < 32 else "bearish" if short_pct > 50 else "neutral"
    return {
        "symbol": symbol,
        "shortVolume": short_vol,
        "shortExempt": raw.get("exempt", 0),
        "totalVolume": total_vol,
        "shortPct": round(short_pct, 1),
        "darkPoolPct": round(100 - short_pct, 1),
        "signal": signal,
        "date": date_str,
    }


def _finra_day(date_str: str, ticker: Optional[str]) -> List[Dict[str, Any]]:
    allsym = _finra_day_all(date_str)
    if ticker:
        raw = allsym.get(ticker)
        return [_dp_entry(ticker, raw, date_str)] if raw else []
    entries = [_dp_entry(sym, raw, date_str)
               for sym, raw in allsym.items() if raw["total"] >= 500000]
    entries.sort(key=lambda e: -e["totalVolume"])
    return entries[:150]


def _dp_history(ticker: str, days: int = 10) -> List[Dict[str, Any]]:
    """Per-ticker dark-pool / short-volume trend over the last ``days`` sessions."""
    day_list = _prev_business_days(days)
    fetched: Dict[str, Dict[str, Dict[str, int]]] = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(_finra_day_all, day): day for day in day_list}
        for fut in as_completed(futs):
            try:
                fetched[futs[fut]] = fut.result()
            except Exception:  # noqa: BLE001
                pass
    out: List[Dict[str, Any]] = []
    for day in reversed(day_list):  # oldest → newest
        raw = (fetched.get(day) or {}).get(ticker)
        if raw and raw["total"]:
            e = _dp_entry(ticker, raw, day)
            out.append({"date": day, "shortPct": e["shortPct"],
                        "darkPoolPct": e["darkPoolPct"], "totalVolume": e["totalVolume"]})
    return out


def darkpool(ticker: Optional[str] = None) -> Dict[str, Any]:
    ticker = (ticker or "").strip().upper() or None

    def _f():
        entries, used = [], ""
        for day in _prev_business_days(4):
            try:
                entries = _finra_day(day, ticker)
            except Exception:  # noqa: BLE001
                entries = []
            if entries:
                used = day
                break
        bullish = [e for e in entries if e["signal"] == "bullish"]
        bearish = [e for e in entries if e["signal"] == "bearish"]
        neutral = [e for e in entries if e["signal"] == "neutral"]
        tot_v = sum(e["totalVolume"] for e in entries)
        tot_s = sum(e["shortVolume"] for e in entries)
        summary = {
            "tracked": len(entries),
            "bullish": len(bullish),
            "bearish": len(bearish),
            "neutral": len(neutral),
            "avgDarkPoolPct": round(100 - (tot_s / tot_v * 100), 1) if tot_v else 0,
            "totalVolume": tot_v,
            "topAccumulation": sorted(entries, key=lambda e: e["shortPct"])[:5],
            "topDistribution": sorted(entries, key=lambda e: -e["shortPct"])[:5],
        }
        history = _dp_history(ticker) if ticker else []
        return {"entries": entries, "bullish": bullish, "bearish": bearish,
                "neutral": neutral, "summary": summary, "history": history,
                "date": used, "ticker": ticker}

    try:
        return _cached(f"dp:{ticker}", 1800, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("darkpool failed: %s", exc)
        return {"entries": [], "bullish": [], "bearish": [], "neutral": [],
                "summary": {}, "history": [], "date": "", "ticker": ticker}


# ── Crypto Whales: on-chain balances ────────────────────────────────────────
WHALE_WALLETS = [
    {"id": "vitalik", "name": "Vitalik Buterin", "label": "Ethereum Co-Founder", "chain": "ETH",
     "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
     "notes": "Publicly associated Ethereum wallet. Has donated large sums to charity.", "verified": True},
    {"id": "eth-foundation", "name": "Ethereum Foundation", "label": "Non-profit org", "chain": "ETH",
     "address": "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe",
     "notes": "Primary Ethereum Foundation treasury wallet.", "verified": True},
    {"id": "satoshi", "name": "Satoshi Nakamoto", "label": "Bitcoin Creator", "chain": "BTC",
     "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7Divfna", "knownBalance": 50,
     "notes": "Genesis block coinbase. The coins have never moved.", "verified": True},
    {"id": "microstrategy", "name": "MicroStrategy / Saylor", "label": "Corporate BTC holder", "chain": "BTC",
     "address": "1P5ZEDWTKTFGxQjZphgWPQUpe554WKDfHQ", "knownBalance": 252220,
     "notes": "One of MicroStrategy's known BTC custody addresses (~252K BTC total).", "verified": False},
    {"id": "binance-cold", "name": "Binance Cold Wallet", "label": "Exchange reserve", "chain": "ETH",
     "address": "0xF977814e90dA44bFA03b6295A0616a897441aceC",
     "notes": "One of Binance's known cold storage ETH wallets.", "verified": True},
    {"id": "coinbase-cold", "name": "Coinbase Custody", "label": "Exchange reserve", "chain": "ETH",
     "address": "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3",
     "notes": "Coinbase known ETH cold storage address.", "verified": True},
]


def _btc_balance(addr: str) -> Optional[float]:
    try:
        d = _get_json(f"https://blockstream.info/api/address/{addr}", timeout=6)
        cs = d.get("chain_stats", {})
        sat = (cs.get("funded_txo_sum", 0) or 0) - (cs.get("spent_txo_sum", 0) or 0)
        return sat / 1e8
    except Exception:  # noqa: BLE001
        return None


def _eth_balance(addr: str) -> Optional[float]:
    try:
        d = _get_json(f"https://eth.blockscout.com/api/v2/addresses/{addr}", timeout=6)
        return int(d.get("coin_balance", "0")) / 1e18
    except Exception:  # noqa: BLE001
        return None


def _crypto_prices() -> Dict[str, float]:
    try:
        d = _get_json(
            "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum"
            "&vs_currencies=usd&include_24hr_change=true",
            timeout=6,
        )
        return {
            "btc": d.get("bitcoin", {}).get("usd", 104000),
            "eth": d.get("ethereum", {}).get("usd", 2400),
            "btcChange": d.get("bitcoin", {}).get("usd_24h_change", 0),
            "ethChange": d.get("ethereum", {}).get("usd_24h_change", 0),
        }
    except Exception:  # noqa: BLE001
        return {"btc": 104000, "eth": 2400, "btcChange": 0, "ethChange": 0}


def crypto_whales() -> Dict[str, Any]:
    def _f():
        prices = _crypto_prices()
        with ThreadPoolExecutor(max_workers=len(WHALE_WALLETS)) as ex:
            futs = {
                ex.submit(_btc_balance if w["chain"] == "BTC" else _eth_balance, w["address"]): i
                for i, w in enumerate(WHALE_WALLETS)
            }
            bal: Dict[int, Optional[float]] = {}
            for fut in as_completed(futs):
                bal[futs[fut]] = fut.result()
        wallets = []
        for i, w in enumerate(WHALE_WALLETS):
            live = bal.get(i)
            balance = live if live is not None else w.get("knownBalance", 0)
            price = prices["btc"] if w["chain"] == "BTC" else prices["eth"]
            wallets.append({**w, "balance": balance, "balanceUsd": round(balance * price),
                            "price": price, "balanceLive": live is not None})
        wallets.sort(key=lambda x: -x["balanceUsd"])
        return {"wallets": wallets, "prices": prices}

    try:
        return _cached("whales", 300, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("crypto_whales failed: %s", exc)
        return {"wallets": [], "prices": _crypto_prices()}


# ── Famous Investors: SEC 13F + ARK ─────────────────────────────────────────
_INVESTOR_META = {
    "berkshire": {"name": "Warren Buffett", "fund": "Berkshire Hathaway", "avatar": "🏦",
                  "strategy": "The Oracle of Omaha — wonderful companies at a fair price", "cik": "1067983", "type": "edgar"},
    "munger": {"name": "Charlie Munger", "fund": "Daily Journal Corp", "avatar": "📰",
               "strategy": "Buffett's partner — only wonderful businesses at fair prices", "cik": "783412", "type": "edgar"},
    "ackman": {"name": "Bill Ackman", "fund": "Pershing Square Capital", "avatar": "♟️",
               "strategy": "Activist — bold, concentrated positions and pushes for change", "cik": "1336528", "type": "edgar"},
    "burry": {"name": "Michael Burry", "fund": "Scion Asset Management", "avatar": "🐻",
              "strategy": "The Big Short contrarian who hunts deep value", "cik": "1649339", "type": "edgar"},
    "ark": {"name": "Cathie Wood", "fund": "ARK Invest (ARKK)", "avatar": "🚀",
            "strategy": "Queen of growth — innovation and disruption", "type": "ark"},
    "pabrai": {"name": "Mohnish Pabrai", "fund": "Dalal Street LLC", "avatar": "🎯",
               "strategy": "Dhandho — heads I win, tails I don't lose much", "cik": "1549575", "type": "edgar"},
    "druckenmiller": {"name": "Stanley Druckenmiller", "fund": "Duquesne Family Office", "avatar": "🌐",
                      "strategy": "Macro legend — asymmetric, concentrated bets", "cik": "1536411", "type": "edgar"},
}


def _xml_tag(body: str, tag: str) -> str:
    m = re.search(rf"<(?:[a-zA-Z][a-zA-Z0-9]*:)?{tag}[^>]*>([\s\S]*?)</(?:[a-zA-Z][a-zA-Z0-9]*:)?{tag}>",
                  body, re.I)
    return m.group(1).strip() if m else ""


def _edgar_investor(cik: str) -> Dict[str, Any]:
    padded = cik.zfill(10)
    sub = _get_json(f"https://data.sec.gov/submissions/CIK{padded}.json",
                    headers={"User-Agent": _EDGAR_UA})
    recent = sub["filings"]["recent"]
    accession = filing_date = None
    for form, date, acc in zip(recent["form"], recent["filingDate"], recent["accessionNumber"]):
        if form == "13F-HR":
            accession, filing_date = acc, date
            break
    if not accession:
        raise RuntimeError(f"no 13F-HR for {cik}")
    acc_clean = accession.replace("-", "")
    idx = _get_text(
        f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc_clean}/{accession}-index.htm",
        headers={"User-Agent": _EDGAR_UA},
    )
    matches = re.findall(r'href="([^"]*(?:infotable|[0-9]+)\.xml)"', idx, re.I)
    if not matches:
        raise RuntimeError("infotable.xml not found")
    raw = next((m for m in matches if "xslForm" not in m), matches[0])
    path = re.sub(r"xslForm[^/]+/", "", raw, flags=re.I)
    if not path.startswith("/"):
        path = f"/Archives/edgar/data/{cik}/{acc_clean}/{path}"
    xml = _get_text(f"https://www.sec.gov{path}", headers={"User-Agent": _EDGAR_UA})
    agg: Dict[str, Dict[str, Any]] = {}
    for body in re.findall(
        r"<(?:[a-zA-Z][a-zA-Z0-9]*:)?infoTable[^>]*>([\s\S]*?)</(?:[a-zA-Z][a-zA-Z0-9]*:)?infoTable>",
        xml, re.I,
    ):
        name = _xml_tag(body, "nameOfIssuer")
        if not name:
            continue
        val = int(_xml_tag(body, "value") or "0")
        shrs = int(_xml_tag(body, "sshPrnamt") or "0")
        pc = _xml_tag(body, "putCall")
        key = f"{name}|||{pc}" if pc else name
        a = agg.setdefault(key, {"value": 0, "shares": 0, "putCall": pc})
        a["value"] += val
        a["shares"] += shrs
    total = sum(h["value"] for h in agg.values())
    holdings = []
    for key, h in agg.items():
        name = key.split("|||")[0].strip()
        pc = key.split("|||")[1] if "|||" in key else ""
        pps = (h["value"] / h["shares"]) if h["shares"] else 0
        holdings.append({
            "name": name, "ticker": None, "value": h["value"], "shares": h["shares"],
            "pricePerShare": round(pps, 2),
            "pctPortfolio": round(h["value"] / total * 1000) / 10 if total else 0,
            "putCall": pc, "isOption": bool(pc),
        })
    holdings.sort(key=lambda x: -x["value"])
    return {"holdings": holdings[:25], "filingDate": filing_date,
            "totalValueUsd": total, "source": "SEC EDGAR"}


def _ark_investor() -> Dict[str, Any]:
    d = _get_json("https://arkfunds.io/api/v2/etf/holdings?symbol=ARKK",
                  headers={"User-Agent": "Mozilla/5.0 (compatible; WhaleWatcher/1.0)"})
    items = d.get("holdings", []) or []
    total = sum(h.get("market_value", 0) or 0 for h in items)
    holdings = []
    for h in items:
        if (h.get("market_value", 0) or 0) <= 500000:
            continue
        holdings.append({
            "name": h.get("company"), "ticker": h.get("ticker"),
            "value": round(h.get("market_value", 0)), "shares": h.get("shares"),
            "pricePerShare": h.get("share_price", 0),
            "pctPortfolio": round(h.get("market_value", 0) / total * 1000) / 10 if total else 0,
            "putCall": "", "isOption": False,
        })
    return {"holdings": holdings[:25], "filingDate": d.get("date_to", ""),
            "totalValueUsd": total, "source": "arkfunds.io (daily)"}


_WIKI_UA = {"User-Agent": "TradeBuddy/1.0 (contact@tradebuddy.app)"}
# Generational suffixes (Jr/Sr/II/III…) are kept — they disambiguate father/son.
_HONORIFICS = {"dr", "mr", "mrs", "ms", "md", "dds", "phd", "rep", "sen", "hon"}
_POL_TERMS = ("politician", "representative", "senator", "governor", "congressman",
              "congresswoman", "u.s. house", "member of congress", "house of representatives")


def _clean_person_name(name: str) -> str:
    """Strip honorifics/credentials and normalise SHOUTING tokens for lookup."""
    toks = re.split(r"[\s,]+", (name or "").strip())
    out = []
    for t in toks:
        if not t or t.strip(".").lower() in _HONORIFICS:
            continue
        out.append(t.capitalize() if t.isupper() else t)
    return " ".join(out) or (name or "")


def _is_politician(d) -> bool:
    desc = ((d or {}).get("description") or "").lower()
    extract = ((d or {}).get("extract") or "")[:160].lower()
    return any(k in desc or k in extract for k in _POL_TERMS)


def _wiki_rest(title: str):
    try:
        return _get_json(
            "https://en.wikipedia.org/api/rest_v1/page/summary/"
            + requests.utils.quote(title.replace(" ", "_")),
            headers=_WIKI_UA, timeout=6,
        )
    except Exception:  # noqa: BLE001
        return None


def _wiki_search_title(query: str):
    """Best-matching article title from Wikipedia full-text search."""
    try:
        d = _get_json(
            "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch="
            + requests.utils.quote(query) + "&srlimit=1&format=json",
            headers=_WIKI_UA, timeout=6,
        )
        hits = d.get("query", {}).get("search", [])
        return hits[0]["title"] if hits else None
    except Exception:  # noqa: BLE001
        return None


def _ok(d) -> bool:
    return bool(d and d.get("extract") and d.get("type") != "disambiguation")


def _wiki_summary(title: str, context: str = "") -> Dict[str, str]:
    """Wikipedia bio extract + lead photo (cached 24h).

    Resolves messy/ambiguous names via search. With ``context="politician"`` the
    search is biased toward US politicians and the result is validated as one, so
    e.g. ``Jonathan Jackson`` lands on the congressman (not the actor) and
    ``Thomas H. Kean Jr`` on the son (not his father).
    """
    def _f():
        name = _clean_person_name(title)
        if context == "politician":
            queries = [f"{name} (politician)", f"{name} U.S. representative",
                       f"{name} U.S. senator", name]
            fallback = None
            for q in queries:
                best = _wiki_search_title(q)
                if not best:
                    continue
                d = _wiki_rest(best)
                if not _ok(d):
                    continue
                if _is_politician(d):
                    return _pack(d)
                fallback = fallback or d
            if fallback:
                return _pack(fallback)
            return {"bio": "", "photo": "", "wikiUrl": ""}
        # Default (investors): the exact name page almost always resolves.
        d = _wiki_rest(name)
        if not _ok(d):
            best = _wiki_search_title(name)
            d = _wiki_rest(best) if best else None
        return _pack(d) if _ok(d) else {"bio": "", "photo": "", "wikiUrl": ""}

    try:
        return _cached(f"wiki:{context}:{title}", 86400, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("wiki summary for %s failed: %s", title, exc)
        return {"bio": "", "photo": "", "wikiUrl": ""}


def _pack(d) -> Dict[str, str]:
    photo = (d.get("thumbnail") or {}).get("source") or (d.get("originalimage") or {}).get("source") or ""
    url = ((d.get("content_urls") or {}).get("desktop") or {}).get("page") or ""
    return {"bio": d.get("extract", ""), "photo": photo, "wikiUrl": url}


def wiki_summary(title: str, context: str = "") -> Dict[str, str]:
    """Public wrapper for the cached Wikipedia bio/photo lookup."""
    return _wiki_summary(title, context)


def _one_investor(inv_id: str, meta: dict) -> Dict[str, Any]:
    wiki = _wiki_summary(meta.get("wiki_title") or meta["name"])
    base = {**meta, "id": inv_id, "bio": wiki["bio"], "photo": wiki["photo"], "wikiUrl": wiki["wikiUrl"]}
    try:
        data = _ark_investor() if meta["type"] == "ark" else _edgar_investor(meta["cik"])
        total = data["totalValueUsd"]
        aum = f"${total / 1e9:.1f}B" if total >= 1e9 else f"${total / 1e6:.0f}M"
        return {**base, "aum": aum, **data}
    except Exception as exc:  # noqa: BLE001
        return {**base, "aum": "N/A", "holdings": [],
                "filingDate": "unavailable", "source": "error", "error": str(exc)}


def investors() -> Dict[str, Any]:
    def _f():
        out: Dict[str, Any] = {}
        with ThreadPoolExecutor(max_workers=len(_INVESTOR_META)) as ex:
            futs = {ex.submit(_one_investor, k, v): k for k, v in _INVESTOR_META.items()}
            for fut in as_completed(futs):
                r = fut.result()
                out[r["id"]] = r
        return out

    try:
        return _cached("investors", 3600, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("investors failed: %s", exc)
        return {}


# ── Congress: QuiverQuant live (with static fallback) ───────────────────────
_CONGRESS_FALLBACK = [
    {"id": "1", "representative": "Nancy Pelosi", "party": "D", "state": "CA", "chamber": "Representatives",
     "ticker": "NVDA", "assetName": "Nvidia Corp", "type": "purchase", "amount": "$500,001 - $1,000,000",
     "transactionDate": "2024-06-14", "disclosureDate": "2024-06-28", "sector": "Technology", "excessReturn": None},
    {"id": "2", "representative": "Nancy Pelosi", "party": "D", "state": "CA", "chamber": "Representatives",
     "ticker": "MSFT", "assetName": "Microsoft Corp", "type": "purchase", "amount": "$1,000,001 - $5,000,000",
     "transactionDate": "2024-01-08", "disclosureDate": "2024-01-19", "sector": "Technology", "excessReturn": None},
    {"id": "3", "representative": "Tommy Tuberville", "party": "R", "state": "AL", "chamber": "Senate",
     "ticker": "XOM", "assetName": "Exxon Mobil Corp", "type": "sale", "amount": "$50,001 - $100,000",
     "transactionDate": "2024-08-20", "disclosureDate": "2024-09-02", "sector": "Energy", "excessReturn": None},
    {"id": "4", "representative": "Ro Khanna", "party": "D", "state": "CA", "chamber": "Representatives",
     "ticker": "TSLA", "assetName": "Tesla Inc", "type": "purchase", "amount": "$15,001 - $50,000",
     "transactionDate": "2024-04-19", "disclosureDate": "2024-05-02", "sector": "Consumer Discretionary", "excessReturn": None},
    {"id": "5", "representative": "Michael McCaul", "party": "R", "state": "TX", "chamber": "Representatives",
     "ticker": "LMT", "assetName": "Lockheed Martin Corp", "type": "purchase", "amount": "$250,001 - $500,000",
     "transactionDate": "2024-10-01", "disclosureDate": "2024-10-15", "sector": "Defense", "excessReturn": None},
]


def _map_congress(t: dict, i: int) -> Dict[str, Any]:
    tx = (t.get("Transaction") or "Purchase").lower()
    desc = t.get("Description") or ""
    return {
        "id": str(i),
        "representative": t.get("Representative", "Unknown"),
        "party": t.get("Party", "I"),
        "state": t.get("State") or "",
        "chamber": t.get("House", "Representatives"),
        "ticker": t.get("Ticker", "--"),
        "assetName": (desc.split(".")[0][:60] if desc else (t.get("Ticker") or "Unknown Asset")),
        "type": "sale" if ("sale" in tx or "sell" in tx) else "purchase",
        "amount": t.get("Range") or t.get("Amount") or "$0",
        "transactionDate": t.get("TransactionDate") or t.get("ReportDate") or "",
        "disclosureDate": t.get("ReportDate") or "",
        "sector": "Stock" if t.get("TickerType") == "ST" else (t.get("TickerType") or "Other"),
        "excessReturn": round(t["ExcessReturn"], 2) if isinstance(t.get("ExcessReturn"), (int, float)) else None,
        "priceChange": round(t["PriceChange"], 2) if isinstance(t.get("PriceChange"), (int, float)) else None,
    }


def congress() -> Dict[str, Any]:
    """Live STOCK Act trades from QuiverQuant's free endpoint.

    That endpoint is flaky — it returns a random 401 ("Authentication credentials
    were not provided") on roughly two of every three hits — so we retry a handful
    of times, cache only successful *live* results, and never re-pin the tiny static
    fallback once real data has been seen.
    """
    hit = _CACHE.get("congress")
    if hit and hit[0].get("source") == "live" and time.time() - hit[1] < 1800:
        return hit[0]

    for attempt in range(5):
        try:
            raw = _get_json(
                "https://api.quiverquant.com/beta/live/congresstrading",
                headers={"User-Agent": "Mozilla/5.0 (compatible; WhaleWatcher/1.0)"},
                timeout=10,
            )
            if isinstance(raw, list) and raw:
                trades = [_map_congress(t, i) for i, t in enumerate(raw[:150])]
                res = {"trades": trades, "source": "live", "provider": "QuiverQuant"}
                _CACHE["congress"] = (res, time.time())
                return res
        except Exception as exc:  # noqa: BLE001
            logger.warning("congress live attempt %d failed: %s", attempt + 1, exc)
        time.sleep(0.4)

    # Every attempt failed: prefer the last good live snapshot (even if stale) over
    # the 5-row static stub, which is only a true last resort.
    if hit and hit[0].get("source") == "live":
        return {**hit[0], "source": "stale"}
    return {"trades": _CONGRESS_FALLBACK, "source": "fallback", "provider": "cached"}


# ── Signal Engine: composite congress + insider + sentiment scoring ─────────
_CIK_TO_TICKER = {
    "320193": "AAPL", "789019": "MSFT", "1045810": "NVDA", "1318605": "TSLA",
    "1326801": "META", "1018724": "AMZN", "1652044": "GOOGL", "2488": "AMD",
    "19617": "JPM", "886982": "GS", "70858": "BAC", "1065280": "NFLX",
    "1321655": "PLTR", "1679788": "COIN", "1403161": "V", "1141391": "MA",
}


def _insider_buy_tickers() -> List[str]:
    try:
        xml = _get_text(
            "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40&output=atom",
            headers={"User-Agent": _EDGAR_UA}, timeout=8,
        )
        ciks = re.findall(r"CIK=(\d+)", xml, re.I)
        return list({_CIK_TO_TICKER[c] for c in ciks if c in _CIK_TO_TICKER})
    except Exception:  # noqa: BLE001
        return []


def _spark_prices(tickers: List[str]) -> Dict[str, float]:
    if not tickers:
        return {}
    try:
        j = _get_json(
            "https://query1.finance.yahoo.com/v8/finance/spark?symbols="
            f"{','.join(tickers)}&range=1d&interval=1d", timeout=8,
        )
        prices = {}
        for item in (j.get("spark", {}).get("result", []) or []):
            closes = (((item.get("response") or [{}])[0].get("indicators", {})
                       .get("quote", [{}])[0]).get("close") or [])
            vals = [c for c in closes if c is not None]
            if vals:
                prices[item["symbol"]] = vals[-1]
        return prices
    except Exception:  # noqa: BLE001
        return {}


def _rating(score: int) -> str:
    if score >= 7:
        return "STRONG BUY"
    if score >= 4:
        return "BUY"
    if score >= 1:
        return "WATCH"
    if score >= -1:
        return "NEUTRAL"
    if score >= -3:
        return "CAUTION"
    return "AVOID"


def signals() -> Dict[str, Any]:
    def _f():
        trades = congress().get("trades", [])
        insider_buys = _insider_buy_tickers()
        fg = fear_greed().get("score", 50)
        cutoff = datetime.utcnow() - timedelta(days=365)
        tmap: Dict[str, Dict[str, int]] = {}
        for t in trades:
            tk = t.get("ticker")
            if not tk or tk == "--" or len(tk) > 5:
                continue
            try:
                d = datetime.fromisoformat((t.get("transactionDate") or "")[:10])
            except Exception:  # noqa: BLE001
                continue
            if d < cutoff:
                continue
            e = tmap.setdefault(tk, {"buys": 0, "sells": 0})
            if t["type"] == "purchase":
                e["buys"] += 1
            else:
                e["sells"] += 1
        top = sorted(tmap.items(), key=lambda kv: -(kv[1]["buys"] + kv[1]["sells"]))[:30]
        top_tickers = [t for t, _ in top]
        prices = _spark_prices(top_tickers)
        iset = set(insider_buys)
        results = []
        for tk in top_tickers:
            buys, sells = tmap[tk]["buys"], tmap[tk]["sells"]
            price = prices.get(tk)
            contributors, score = [], 0
            if buys >= 5:
                score += 4; contributors.append(f"Congress: {buys} buys")
            elif buys >= 3:
                score += 3; contributors.append(f"Congress: {buys} buys")
            elif buys >= 1:
                score += 2; contributors.append(f"Congress: {buys} buy")
            if sells >= 5:
                score -= 3; contributors.append(f"Congress: {sells} sells")
            elif sells >= 3:
                score -= 2
            elif sells >= 1 and buys == 0:
                score -= 1
            if tk in iset:
                score += 2; contributors.append("Insider buying")
            fg_sig = "neutral"
            if fg <= 25:
                score += 1; fg_sig = "bullish"; contributors.append("Extreme Fear (contrarian buy)")
            elif fg >= 75:
                score -= 1; fg_sig = "bearish"
            rating = _rating(score)
            stop_pct = {"STRONG BUY": 5, "BUY": 4, "WATCH": 3, "CAUTION": 5, "AVOID": 8}.get(rating, 0)
            tgt_pct = {"STRONG BUY": 20, "BUY": 15, "WATCH": 10, "CAUTION": 8, "AVOID": 5}.get(rating, 0)
            results.append({
                "ticker": tk, "score": score, "rating": rating,
                "entryPrice": price,
                "stopLoss": round(price * (1 - stop_pct / 100), 2) if price else None,
                "target": round(price * (1 + tgt_pct / 100), 2) if price else None,
                "stopPct": stop_pct, "targetPct": tgt_pct,
                "riskReward": round(tgt_pct / stop_pct, 1) if stop_pct else 0,
                "signals": {"congressBuys": buys, "congressSells": sells,
                            "insiderBuys": 1 if tk in iset else 0, "insiderSells": 0,
                            "callsVsPuts": fg_sig, "fearGreed": fg},
                "contributors": contributors,
            })
        results.sort(key=lambda r: -r["score"])
        return {"signals": results, "fearGreed": fg, "insiderCount": len(insider_buys),
                "lastUpdated": datetime.utcnow().isoformat()}

    try:
        return _cached("signals", 300, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("signals failed: %s", exc)
        return {"signals": [], "error": str(exc)}


# ── Background cache warmer hooks ───────────────────────────────────────────
# The webapp runs a daemon thread (see webapp/server.py) that calls these on a
# fixed cadence so the slow Whale feeds are always sitting in the in-process
# cache — a user clicking a tab reads them instantly instead of triggering (and
# waiting on) the live upstream fetch. Each helper force-refreshes by dropping
# its cache key first, then recomputing.
def prewarm_congress() -> None:
    _CACHE.pop("congress", None)
    congress()


def prewarm_darkpool() -> None:
    _CACHE.pop("dp:None", None)
    darkpool()


def prewarm_investors() -> None:
    _CACHE.pop("investors", None)
    investors()
