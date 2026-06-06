"""Smart-money feeds for the dashboard: corporate insiders and congressional trades.

Two keyless public sources:
* **Corporate insiders** (officers/directors + 10%-owner "whales") — SEC Form 4
  via OpenInsider.com (HTML, parsed with BeautifulSoup).
* **Capitol Hill** (House + Senate + executive branch) — Kadoa open STOCK Act dataset.

Each builder returns a list of normalized card dicts and degrades to an empty
list + a human note when a feed is unavailable, so the page always renders.
Pass ``symbol`` to filter to one ticker; omit it for the latest market-wide
activity.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from tradingagents.dataflows import (
    congress_kadoa_utils,
    finnlp_sources,
    openinsider_utils,
)

logger = logging.getLogger(__name__)

# Cache for the market-wide (no-symbol) view — the Whale "Insiders" tab. Both
# OpenInsider and Kadoa are slow HTML scrapes, so caching this turns a multi-
# second click into an instant read. The background warmer keeps it fresh.
_BROAD_CACHE: Dict[str, Any] = {"data": None, "ts": 0.0}
_BROAD_TTL = 600.0   # 10 minutes


def _first_nonempty(*fetchers):
    """Try each ``(label, callable)`` in turn; return the first non-empty list.

    Mirrors the vendor router's fallback chain for the webapp, which calls the
    fetchers directly. A failing source is logged and skipped, not fatal.
    """
    for label, fn in fetchers:
        try:
            rows = fn()
            if rows:
                return rows
        except Exception as exc:  # noqa: BLE001
            logger.warning("smart-money source '%s' failed: %s", label, exc)
    return []


def insider_cards(symbol: Optional[str] = None, limit: int = 40) -> List[Dict[str, Any]]:
    """Corporate insider (Form 4) cards: OpenInsider → Finnhub fallback."""
    rows = _first_nonempty(
        ("openinsider", lambda: openinsider_utils.fetch_insider(symbol=symbol, limit=limit)),
        ("finnhub", lambda: finnlp_sources.fetch_finnhub_insider(symbol, limit=limit) if symbol else []),
    )
    return [{
        "symbol": r.get("symbol", ""),
        "name": r.get("name", "Insider"),
        "role": r.get("role", ""),
        "side": r.get("side", "other"),
        "type": r.get("type", ""),
        "shares": r.get("shares", ""),
        "price": r.get("price", ""),
        "value": r.get("value", ""),
        "date": r.get("date", ""),
        "disclosed": r.get("filingDate", ""),
    } for r in rows[:limit]]


def congress_cards(symbol: Optional[str] = None, limit: int = 40) -> List[Dict[str, Any]]:
    """House + Senate + executive cards (chamber-tagged), via the Kadoa dataset."""
    rows = _first_nonempty(
        ("kadoa", lambda: congress_kadoa_utils.fetch_congress(symbol=symbol, limit=limit)),
    )
    return [{
        "chamber": r.get("chamber", "Congress"),
        "name": r.get("name", "Member"),
        "party": r.get("party", ""),
        "symbol": r.get("symbol", ""),
        "asset": r.get("asset", ""),
        "side": r.get("side", "other"),
        "type": r.get("type", ""),
        "amount": r.get("amount", ""),
        "date": r.get("date", ""),
        "disclosed": r.get("disclosed", ""),
    } for r in rows[:limit]]


def most_traded_congress(top: int = 14, sample: int = 2000) -> List[Dict[str, Any]]:
    """Most-traded tickers across recent congressional trades (à la congress.kadoa.com).

    Counts ticker frequency (with buy/sell split) over the latest Kadoa trades.
    """
    try:
        rows = congress_kadoa_utils.fetch_congress(symbol=None, limit=sample)
    except Exception as exc:  # noqa: BLE001
        logger.warning("most-traded congress failed: %s", exc)
        return []
    counts: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        s = (r.get("symbol") or "").strip().upper()
        if not s:
            continue
        d = counts.setdefault(s, {"symbol": s, "count": 0, "buys": 0, "sells": 0})
        d["count"] += 1
        if r.get("side") == "buy":
            d["buys"] += 1
        elif r.get("side") == "sell":
            d["sells"] += 1
    return sorted(counts.values(), key=lambda x: x["count"], reverse=True)[:top]


def smart_money(symbol: Optional[str] = None) -> Dict[str, Any]:
    """Aggregate the smart-money feeds for the dashboard.

    Returns ``{symbol, available, note, insider, congress, most_traded}``. Each
    feed degrades independently; ``most_traded`` is populated only for the broad
    (no-symbol) view.
    """
    sym = (symbol or "").strip().upper() or None
    notes: List[str] = []

    # Serve the market-wide view from the short-TTL cache when fresh.
    if sym is None:
        hit = _BROAD_CACHE
        if hit["data"] is not None and time.time() - hit["ts"] < _BROAD_TTL:
            return hit["data"]

    insider = insider_cards(sym)
    if not insider:
        notes.append("Corporate insider feed is unavailable (OpenInsider / Finnhub).")

    congress = congress_cards(sym)
    if not congress:
        notes.append(
            "Congressional feed (Kadoa) is unavailable." if sym else
            "No recent congressional trades found."
        )

    result = {
        "symbol": sym,
        "available": bool(insider or congress),
        "note": " ".join(notes),
        "insider": insider,
        "congress": congress,
        "most_traded": [] if sym else most_traded_congress(),
    }
    if sym is None:
        _BROAD_CACHE.update(data=result, ts=time.time())
    return result


def prewarm() -> None:
    """Force-refresh the market-wide insiders view (background warmer hook)."""
    _BROAD_CACHE["ts"] = 0.0
    smart_money(None)
