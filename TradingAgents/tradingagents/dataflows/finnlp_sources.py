"""Adapters over the vendored FinNLP data sources (``finnlp.data_sources.*``).

A curated, reliable subset wired into our pipeline to complement the existing
vendors:

* **Finnhub company news** — an alternative ``get_news`` vendor (needs
  ``FINNHUB_API_KEY``).
* **Finnhub social sentiment** — Reddit/Twitter mention & score summary for the
  sentiment analyst (needs ``FINNHUB_API_KEY``; premium endpoint).
* **AKShare CCTV news** — China macro/state news, an alternative
  ``get_global_news`` vendor (no key; mainland endpoint).
* **Google Trends** — public search-interest signal for the sentiment analyst
  (no key; via ``pytrends``).

Every function degrades to a clear string instead of raising, so a missing key,
an uninstalled optional dep, or a blocked endpoint never aborts an analysis run.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta
from typing import Annotated, List, Optional

import requests

logger = logging.getLogger(__name__)

_FINNHUB_REST = "https://finnhub.io/api/v1"


def _finnhub_token() -> Optional[str]:
    return os.environ.get("FINNHUB_API_KEY")


# --- Finnhub corporate insider transactions (insider fallback) --------------

# SEC Form-4 transaction codes → direction. Open-market purchase/sale are the
# meaningful signals; grants, gifts, exercises and tax dispositions are "other".
_INSIDER_CODE_SIDE = {"P": "buy", "S": "sell"}


def _insider_side(code: str, change) -> str:
    code = (code or "").strip().upper()
    if code:
        # A known transaction code is authoritative: only open-market purchases
        # (P) and sales (S) are buy/sell; grants, gifts, exercises, tax (A/G/M/F…)
        # are "other" — don't misread a gift's share drop as a bearish sale.
        return _INSIDER_CODE_SIDE.get(code, "other")
    try:
        c = float(change)
        return "buy" if c > 0 else "sell" if c < 0 else "other"
    except (TypeError, ValueError):
        return "other"


def parse_finnhub_insider(payload, limit: int = 50) -> List[dict]:
    """Pure parser (no network) for Finnhub stock/insider-transactions JSON."""
    data = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(data, list):
        return []
    rows: List[dict] = []
    for r in data[:limit]:
        change = r.get("change")
        price = r.get("transactionPrice")
        shares = abs(change) if isinstance(change, (int, float)) else (r.get("share") or "")
        value = ""
        if isinstance(change, (int, float)) and isinstance(price, (int, float)) and price:
            value = round(abs(change) * price)
        rows.append({
            "symbol": r.get("symbol", ""),
            "name": (r.get("name") or "Insider").title(),
            "role": "",  # Finnhub omits insider title
            "side": _insider_side(r.get("transactionCode"), change),
            "type": r.get("transactionCode") or "",
            "shares": shares,
            "price": price if price else "",
            "value": value,
            "date": r.get("transactionDate") or r.get("filingDate") or "",
            "filingDate": r.get("filingDate") or "",
        })
    return rows


def fetch_finnhub_insider(ticker: str, limit: int = 50) -> List[dict]:
    """Corporate insider transactions for ``ticker`` from Finnhub (raises if no key)."""
    token = _finnhub_token()
    if not token:
        raise RuntimeError("FINNHUB_API_KEY not set")
    resp = requests.get(
        f"{_FINNHUB_REST}/stock/insider-transactions",
        params={"symbol": ticker.upper(), "token": token}, timeout=20,
    )
    resp.raise_for_status()
    return parse_finnhub_insider(resp.json(), limit=limit)


def get_finnhub_insider(ticker: Annotated[str, "ticker symbol"]) -> str:
    """Recent corporate insider (Form 4) activity for ``ticker``, via Finnhub.

    Raises (so the vendor router falls through) when no key, on error, or when
    Finnhub returns nothing for the symbol.
    """
    rows = fetch_finnhub_insider(ticker, limit=40)
    if not rows:
        raise RuntimeError(f"No Finnhub insider data for '{ticker}'")
    parts = [
        f"# Corporate insider trades for {ticker.upper()} (Finnhub / SEC Form 4)",
        f"# Data retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
    ]
    for r in rows[:40]:
        parts.append(
            f"- {r['date'] or '?'} · {r['name']}: code {r['type'] or '?'} "
            f"({r['side']}) {r['shares']} sh @ {r['price'] or '?'}"
        )
    return "\n".join(parts)


# --- Finnhub company news (get_news vendor) ---------------------------------


def get_finnhub_news(
    ticker: Annotated[str, "ticker symbol"],
    start_date: Annotated[str, "start date yyyy-mm-dd"],
    end_date: Annotated[str, "end date yyyy-mm-dd"],
) -> str:
    """Company news for ``ticker`` from Finnhub (FinNLP ``Finnhub_Date_Range``)."""
    token = _finnhub_token()
    if not token:
        raise RuntimeError("FINNHUB_API_KEY not set")  # let the router fall through
    # Finnhub's company-news endpoint accepts the whole window in a single
    # request. (FinNLP's Finnhub_Date_Range chunks it into 4-day slices with a
    # 1s sleep between each — minutes for a wide range. We hit the REST endpoint
    # directly instead: one call, no sleeps.)
    try:
        resp = requests.get(
            f"{_FINNHUB_REST}/company-news",
            params={"symbol": ticker.upper(), "from": start_date,
                    "to": end_date, "token": token},
            timeout=20,
        )
        resp.raise_for_status()
        rows = resp.json() or []
    except Exception as e:  # noqa: BLE001 — re-raise so the router falls back to yfinance
        raise RuntimeError(f"Finnhub news failed for '{ticker}': {e}") from e

    if not isinstance(rows, list) or not rows:
        # Raise (don't return a stub) so the vendor router falls through to the
        # next news source instead of reporting "no news".
        raise RuntimeError(f"No Finnhub news for '{ticker}' in {start_date}..{end_date}")

    # Newest first, capped — the endpoint can return hundreds of items.
    rows.sort(key=lambda r: r.get("datetime", 0), reverse=True)
    parts = [f"## Finnhub news for {ticker.upper()} ({start_date} to {end_date})\n"]
    for r in rows[:40]:
        ts = r.get("datetime", 0)
        when = datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if ts else ""
        head = r.get("headline", "")
        src = r.get("source", "")
        summary = (str(r.get("summary", "")) or "").replace("\n", " ").strip()
        parts.append(f"### {head}\n**{when}** — {src}\n{summary[:500]}")
    return "\n\n".join(parts)


# --- Finnhub social sentiment (sentiment analyst) ---------------------------


def get_finnhub_sentiment(
    ticker: Annotated[str, "ticker symbol"],
    start_date: Annotated[str, "start date yyyy-mm-dd"],
    end_date: Annotated[str, "end date yyyy-mm-dd"],
) -> str:
    """Reddit/Twitter mention & score summary from Finnhub social sentiment."""
    token = _finnhub_token()
    if not token:
        return "Finnhub sentiment unavailable (set FINNHUB_API_KEY)."
    try:
        from finnlp.data_sources.social_media.finnhub_sentiment import Finnhub_Sentiment

        dl = Finnhub_Sentiment({"token": token})
        dl.download_sentiment(start_date, end_date, stock=ticker.upper())
        reddit, twitter = dl.reddit, dl.twitter
    except Exception as e:  # noqa: BLE001
        return f"Finnhub sentiment unavailable for '{ticker}': {e}"

    def _summ(df, label):
        if df is None or df.empty:
            return f"{label}: no data"
        n = len(df)
        mentions = int(df["mention"].sum()) if "mention" in df else n
        score = None
        for col in ("score", "sentiment"):
            if col in df:
                score = float(df[col].mean())
                break
        sc = f", avg score {score:+.3f}" if score is not None else ""
        return f"{label}: {mentions} mentions across {n} buckets{sc}"

    return (
        f"## Finnhub social sentiment for {ticker.upper()} ({start_date} to {end_date})\n"
        f"- {_summ(reddit, 'Reddit')}\n- {_summ(twitter, 'Twitter/X')}"
    )


# --- AKShare CCTV macro news (get_global_news vendor) -----------------------


def get_cctv_news(
    curr_date: Annotated[str, "as-of date yyyy-mm-dd"],
    look_back_days: Annotated[Optional[int], "days to look back"] = None,
    limit: Annotated[Optional[int], "max items"] = None,
) -> str:
    """China macro/state news (CCTV 新闻联播) via AKShare, over a recent window."""
    look_back_days = look_back_days or 3
    limit = limit or 40
    try:
        from finnlp.data_sources.news.akshare_cctv import Akshare_cctv

        end = datetime.strptime(curr_date, "%Y-%m-%d")
        start = end - timedelta(days=look_back_days)
        dl = Akshare_cctv()
        dl.download_news(start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
        df = dl.dataframe
    except Exception as e:  # noqa: BLE001
        return f"CCTV macro news unavailable: {e}"

    if df is None or df.empty:
        return f"No CCTV macro news around {curr_date}."
    title_col = "title" if "title" in df else df.columns[min(1, len(df.columns) - 1)]
    parts = [f"## CCTV macro news (China) — last {look_back_days}d to {curr_date}\n"]
    for _, r in df.head(limit).iterrows():
        parts.append(f"- {r.get(title_col, '')}")
    return "\n".join(parts)


# --- Google Trends (sentiment analyst) --------------------------------------


def get_google_trends(
    keyword: Annotated[str, "search keyword (e.g. company name or ticker)"],
    start_date: Annotated[Optional[str], "start yyyy-mm-dd"] = None,
    end_date: Annotated[Optional[str], "end yyyy-mm-dd"] = None,
) -> str:
    """Google search-interest trend for ``keyword`` (via pytrends)."""
    end = end_date or datetime.today().strftime("%Y-%m-%d")
    start = start_date or (datetime.today() - timedelta(days=90)).strftime("%Y-%m-%d")
    try:
        from finnlp.data_sources.trends.google import Google_Trends

        res = Google_Trends().download(start, end, stock=keyword)
    except Exception as e:  # noqa: BLE001
        return f"Google Trends unavailable for '{keyword}': {e}"

    if res is None or res.empty or keyword not in res:
        return f"No Google Trends data for '{keyword}'."
    series = res[keyword].dropna()
    if series.empty:
        return f"No Google Trends data for '{keyword}'."
    first, last, peak = float(series.iloc[0]), float(series.iloc[-1]), float(series.max())
    direction = "rising" if last > first else "falling" if last < first else "flat"
    return (
        f"## Google search interest for '{keyword}' ({start} to {end})\n"
        f"Latest interest index {last:.0f}/100 ({direction} from {first:.0f}; peak {peak:.0f}). "
        f"Higher = more retail search attention."
    )
