"""Corporate insider trading via OpenInsider.com (SEC Form 4 aggregator).

OpenInsider scrapes and tabulates SEC Form 4 filings — officer/director and
10%-owner ("whale") open-market buys and sells. We parse its HTML table with
BeautifulSoup. Pass a ``symbol`` for a single ticker, or omit it for the latest
market-wide insider activity.

Every function degrades to a clear string / empty list rather than raising for
non-key problems, but raises on a genuinely failed fetch so the vendor router
can fall through to another insider source (e.g. yfinance).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated, List, Optional

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_BASE = "http://openinsider.com"
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; TradeBuddy/1.0; +https://example.com)"}
_TIMEOUT = 20

# Full screener query string (kept explicit so the result table is stable). The
# leading "s" (symbol) is filled in per request; cnt caps the row count.
_SCREENER = (
    "/screener?s={symbol}&o=&pl=&ph=&ll=&lh=&fd=730&fdr=&td=0&tdr=&fdlyl=&fdlyh="
    "&daysago=&xp=1&xs=1&vl=&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0"
    "&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt={cnt}&page=1"
)
_LATEST = "/latest-insider-trading"


def _col(headers: List[str], *keywords: str) -> Optional[int]:
    """Index of the first header containing any keyword (case-insensitive)."""
    for i, h in enumerate(headers):
        hl = h.lower()
        if any(k in hl for k in keywords):
            return i
    return None


def _side(trade_type: str) -> str:
    t = (trade_type or "").lower()
    if "p" == t[:1] or "purchase" in t or "buy" in t:
        return "buy"
    if "s" == t[:1] or "sale" in t or "sell" in t:
        return "sell"
    return "other"


def fetch_insider(symbol: Optional[str] = None, limit: int = 40) -> List[dict]:
    """Parse OpenInsider into a list of normalized insider-trade dicts.

    Returns ``[]`` if the table is missing; raises on a failed HTTP fetch so the
    router can fall through to another vendor.
    """
    url = _BASE + (
        _SCREENER.format(symbol=symbol.upper(), cnt=min(max(limit, 10), 500))
        if symbol else _LATEST
    )
    resp = requests.get(url, headers=_HEADERS, timeout=_TIMEOUT)
    resp.raise_for_status()
    return parse_openinsider_html(resp.text, limit=limit)


def parse_openinsider_html(html: str, limit: int = 40) -> List[dict]:
    """Pure parser (no network) so it can be unit-tested against fixtures."""
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", class_="tinytable")
    if table is None:
        return []

    headers = [th.get_text(strip=True) for th in table.select("thead th")]
    i_filing = _col(headers, "filing")
    i_trade = _col(headers, "trade date", "trade\xa0date") or _col(headers, "trade")
    i_ticker = _col(headers, "ticker")
    i_name = _col(headers, "insider")
    i_title = _col(headers, "title")
    i_type = _col(headers, "trade type", "type")
    i_price = _col(headers, "price")
    i_qty = _col(headers, "qty", "quantity")
    i_owned = _col(headers, "owned")
    i_value = _col(headers, "value")

    def cell(cells, idx):
        return cells[idx] if idx is not None and idx < len(cells) else ""

    rows: List[dict] = []
    body_rows = table.select("tbody tr") or table.find_all("tr")
    for tr in body_rows:
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(cells) < 4:
            continue
        ttype = cell(cells, i_type)
        rows.append({
            "symbol": cell(cells, i_ticker),
            "name": cell(cells, i_name) or "Insider",
            "role": cell(cells, i_title),
            "type": ttype,
            "side": _side(ttype),
            "shares": cell(cells, i_qty),
            "price": cell(cells, i_price),
            "owned": cell(cells, i_owned),
            "value": cell(cells, i_value),
            "date": cell(cells, i_trade),
            "filingDate": cell(cells, i_filing),
        })
        if len(rows) >= limit * 3:  # collect extra, then sort + trim below
            break
    # Sort by *disclosure* (filing) date, newest first — not the alphabetical
    # insider-name order OpenInsider's screener can return. Fall back to the
    # trade date when a filing date is absent; undated rows sink to the bottom.
    rows.sort(key=lambda r: (r.get("filingDate") or r.get("date") or ""), reverse=True)
    return rows[:limit]


def get_insider_transactions(ticker: Annotated[str, "ticker symbol"]) -> str:
    """Recent corporate insider (Form 4) activity for ``ticker``, via OpenInsider."""
    try:
        rows = fetch_insider(symbol=ticker, limit=40)
    except Exception as e:  # noqa: BLE001 — re-raise so the router falls through
        raise RuntimeError(f"OpenInsider fetch failed for '{ticker}': {e}") from e

    if not rows:
        raise RuntimeError(f"No OpenInsider Form-4 activity for '{ticker}'")

    parts = [
        f"# Corporate insider trades for {ticker.upper()} (OpenInsider / SEC Form 4)",
        f"# Data retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "Officer/director and 10%-owner ('whale') open-market transactions. "
        "Cluster buying by multiple insiders is a strong bullish tell; routine "
        "scheduled sales are weak signals.",
        "",
    ]
    for r in rows[:40]:
        parts.append(
            f"- {r['date'] or '?'} · {r['name']} ({r['role'] or 'insider'}): "
            f"{r['type'] or r['side']} {r['shares'] or '?'} sh @ {r['price'] or '?'} "
            f"· value {r['value'] or '?'}"
        )
    return "\n".join(parts)
