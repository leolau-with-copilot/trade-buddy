"""Financial news via Finviz (vendored ``finvizfinance`` scraper).

Two feeds, normalized to the webapp's news-card schema:

* **general market news** — Finviz's curated news + blogs page (macro feed)
* **per-ticker news** — the headlines Finviz aggregates on a stock's quote page

Finviz returns a source domain and a headline/link but no images or timestamps
beyond a short "HH:MMAM / Mon-DD" string, so we parse that into an epoch and
leave the thumbnail empty (the UI shows a placeholder). Everything degrades to
``[]`` on failure so the aggregator never breaks.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import List, Optional

logger = logging.getLogger(__name__)


def _parse_finviz_date(raw) -> int:
    """Finviz date strings → epoch seconds (best-effort)."""
    if isinstance(raw, datetime):
        return int(raw.timestamp())
    s = str(raw or "").strip()
    if not s:
        return 0
    now = datetime.now()
    # Time-only (e.g. "05:30AM") → today at that time.
    try:
        t = datetime.strptime(s, "%I:%M%p")
        return int(now.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0).timestamp())
    except ValueError:
        pass
    for fmt in ("%b-%d-%y %I:%M%p", "%b-%d-%Y %I:%M%p", "%b-%d %I:%M%p", "%b-%d-%y", "%b-%d"):
        try:
            t = datetime.strptime(s, fmt)
            if t.year == 1900:
                t = t.replace(year=now.year)
            return int(t.timestamp())
        except ValueError:
            continue
    return 0


def _src(domain: str) -> str:
    """'www.wsj.com' → 'wsj.com' for a tidy source label."""
    return (domain or "Finviz").replace("www.", "").strip() or "Finviz"


def fetch_general_news(limit: int = 30) -> List[dict]:
    """Finviz front-page market news + blogs as normalized cards."""
    try:
        from finvizfinance.news import News
        data = News().get_news()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Finviz general news failed: %s", exc)
        return []
    cards: List[dict] = []
    for key in ("news", "blogs"):
        df = data.get(key)
        if df is None or df.empty:
            continue
        for _, r in df.head(limit).iterrows():
            cards.append({
                "title": r.get("Title", ""), "source": _src(r.get("Source", "")),
                "published": _parse_finviz_date(r.get("Date")), "link": r.get("Link", ""),
                "thumbnail": "", "tickers": [], "summary": "",
            })
    return cards


def fetch_ticker_news(symbol: str, limit: int = 30) -> List[dict]:
    """Finviz quote-page headlines for ``symbol`` as normalized cards."""
    try:
        from finvizfinance.quote import finvizfinance
        df = finvizfinance(symbol.upper()).ticker_news()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Finviz ticker news failed for %s: %s", symbol, exc)
        return []
    if df is None or df.empty:
        return []
    out: List[dict] = []
    for _, r in df.head(limit).iterrows():
        out.append({
            "title": r.get("Title", ""), "source": _src(r.get("Source", "")),
            "published": _parse_finviz_date(r.get("Date")), "link": r.get("Link", ""),
            "thumbnail": "", "tickers": [symbol.upper()], "summary": "",
        })
    return out


def fetch_news(symbol: Optional[str] = None, limit: int = 30) -> List[dict]:
    return fetch_ticker_news(symbol, limit) if symbol else fetch_general_news(limit)


# --- Agent vendor adapters (markdown string, matching the dataflow router) ---
def _cards_to_markdown(cards: List[dict], header: str) -> str:
    parts = [f"## {header}"]
    for c in cards:
        head = c.get("title") or ""
        if not head:
            continue
        src = c.get("source") or "Finviz"
        ts = c.get("published") or 0
        when = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else "recent"
        parts.append(f"### {head}\n**{when}** — {src}")
    if len(parts) == 1:
        raise RuntimeError("Finviz returned no usable headlines")  # let the router fall through
    return "\n\n".join(parts)


def get_finviz_news(
    ticker: str, start_date: str = "", end_date: str = "", limit: int = 30,
) -> str:
    """Per-ticker Finviz headlines (``get_news`` vendor). Dates bound the window."""
    cards = fetch_ticker_news(ticker, limit)
    if start_date or end_date:
        def _in_window(c):
            ts = c.get("published") or 0
            if not ts:
                return True
            d = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
            return (not start_date or d >= start_date) and (not end_date or d <= end_date)
        cards = [c for c in cards if _in_window(c)]
    return _cards_to_markdown(cards, f"Finviz news for {ticker.upper()}")


def get_finviz_global_news(
    curr_date: str = "", look_back_days: Optional[int] = None, limit: Optional[int] = None,
) -> str:
    """Finviz front-page market news (``get_global_news`` vendor)."""
    return _cards_to_markdown(fetch_general_news(limit or 30), "Finviz market news")
