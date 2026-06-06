"""Congressional + executive-branch trades via the Kadoa open STOCK Act dataset.

Source: the ``congress.kadoa.com`` open dataset (MIT-licensed; integrated from
the ``congress-trading-monitor`` project). It aggregates the House Clerk, Senate
eFD, and Office of Government Ethics disclosures — 54k+ transactions, current to
within a few weeks — and serves them as static JSON, so we read them directly
with no API key:

* per-ticker:  ``https://congress.kadoa.com/data/ticker/<SYMBOL>.json``
* latest all:  ``https://congress.kadoa.com/data/trades.json``

If the live host is unreachable, we fall back to a local copy of the dataset
(the downloaded ``congress-trading-monitor-main/public/data`` folder) when one
is found or configured via ``congress_data_dir``. Every entry point raises on a
hard failure so the vendor router degrades gracefully.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime
from typing import Annotated, List, Optional

import requests

from .config import get_config

logger = logging.getLogger(__name__)

_LIVE_BASE = "https://congress.kadoa.com/data"
_TIMEOUT = 30

# In-memory cache for the market-wide latest feed (4 MB) — refreshed hourly.
_LATEST_CACHE: dict = {"at": 0.0, "rows": None}
_LATEST_TTL = 3600


def _local_data_dir() -> Optional[str]:
    """Locate a local copy of the Kadoa ``public/data`` dir, if available.

    Honors ``config['congress_data_dir']`` / ``$CONGRESS_DATA_DIR`` first, then
    auto-detects the bundled ``congress-trading-monitor-main`` download next to
    the project root.
    """
    configured = get_config().get("congress_data_dir") or os.environ.get("CONGRESS_DATA_DIR")
    candidates = [configured] if configured else []
    project_dir = get_config().get("project_dir", "")
    roots = [project_dir, os.path.dirname(project_dir), os.getcwd()]
    for root in roots:
        if root:
            candidates.append(os.path.join(root, "congress-trading-monitor-main", "public", "data"))
    for c in candidates:
        if c and os.path.isdir(c):
            return c
    return None


def _side(transaction_type: str) -> str:
    t = (transaction_type or "").lower()
    if "purchase" in t or "buy" in t:
        return "buy"
    if "sale" in t or "sell" in t:
        return "sell"
    return "other"


def _chamber(t: dict) -> str:
    chamber = (t.get("chamber") or "").lower()
    if chamber == "house":
        return "House"
    if chamber == "senate":
        return "Senate"
    if (t.get("branch") or "").lower() == "executive":
        return "Executive"
    return "Congress"


def _normalize(t: dict) -> dict:
    return {
        "chamber": _chamber(t),
        "name": t.get("filer_name") or t.get("agency") or "Member",
        "party": t.get("party") or "",
        "symbol": (t.get("ticker") or "").upper(),
        "asset": t.get("asset_name") or t.get("ticker") or "",
        "type": t.get("transaction_type") or "",
        "side": _side(t.get("transaction_type")),
        "amount": t.get("amount_range_label") or "",
        "date": t.get("transaction_date") or "",
        "disclosed": t.get("filing_date") or t.get("notification_date") or "",
        "is_late": bool(t.get("is_late")),
        "doc_url": t.get("doc_url") or "",
    }


def parse_kadoa_trades(
    payload, symbol: Optional[str] = None, limit: int = 50
) -> List[dict]:
    """Pure parser (no network) for a Kadoa ticker file or the all-trades list."""
    if isinstance(payload, dict):
        trades = payload.get("trades") or []
    elif isinstance(payload, list):
        trades = payload
    else:
        return []
    sym = symbol.upper() if symbol else None
    rows = []
    for t in trades:
        if not isinstance(t, dict):
            continue
        row = _normalize(t)
        if sym and row["symbol"] != sym:
            continue
        rows.append(row)
    # Sort by *disclosure* (filing) date, newest first — when a trade was made
    # public, not who filed it. Fall back to the trade date if a filing date is
    # missing so undated rows still order sensibly (and sink to the bottom).
    rows.sort(key=lambda r: (r.get("disclosed") or r.get("date") or ""), reverse=True)
    return rows[:limit]


def _load_local(symbol: Optional[str]) -> Optional[list]:
    data_dir = _local_data_dir()
    if not data_dir:
        return None
    try:
        if symbol:
            path = os.path.join(data_dir, "ticker", f"{symbol.upper()}.json")
        else:
            path = os.path.join(data_dir, "trades.json")
        if not os.path.isfile(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001
        logger.warning("Local Kadoa data read failed (%s): %s", symbol, e)
        return None


def fetch_congress(symbol: Optional[str] = None, limit: int = 50) -> List[dict]:
    """Congressional + executive trades from Kadoa, optionally filtered to ``symbol``.

    Tries the live host first, then a local copy of the dataset. Raises if both
    are unavailable so the router can fall through to another congress vendor.
    """
    # Market-wide latest: cache the 4 MB all-trades feed.
    if not symbol:
        now = time.time()
        if _LATEST_CACHE["rows"] is None or now - _LATEST_CACHE["at"] > _LATEST_TTL:
            payload = None
            try:
                resp = requests.get(f"{_LIVE_BASE}/trades.json", timeout=_TIMEOUT)
                resp.raise_for_status()
                payload = resp.json()
            except Exception as e:  # noqa: BLE001
                logger.warning("Kadoa live latest feed failed: %s", e)
                payload = _load_local(None)
            if payload is None:
                raise RuntimeError("Kadoa latest congressional feed unavailable")
            _LATEST_CACHE.update(at=now, rows=payload)
        return parse_kadoa_trades(_LATEST_CACHE["rows"], symbol=None, limit=limit)

    # Per-ticker file.
    payload = None
    try:
        resp = requests.get(f"{_LIVE_BASE}/ticker/{symbol.upper()}.json", timeout=_TIMEOUT)
        if resp.status_code == 404:
            payload = {"trades": []}  # ticker simply has no congressional trades
        else:
            resp.raise_for_status()
            payload = resp.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("Kadoa live ticker fetch failed for %s: %s", symbol, e)
        payload = _load_local(symbol)
    if payload is None:
        raise RuntimeError(f"Kadoa congressional feed unavailable for '{symbol}'")
    return parse_kadoa_trades(payload, symbol=symbol, limit=limit)


def get_congress_trading(ticker: Annotated[str, "ticker symbol"]) -> str:
    """Disclosed U.S. House + Senate + executive trades in ``ticker`` (Kadoa dataset)."""
    rows = fetch_congress(symbol=ticker, limit=30)  # raises on hard failure → router falls through
    if not rows:
        raise RuntimeError(f"No Kadoa congressional trades for '{ticker}'")

    parts = [
        f"# Congressional & executive trading in {ticker.upper()} (Kadoa / STOCK Act disclosures)",
        f"# Data retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "Sourced from House Clerk, Senate eFD, and OGE filings. Disclosures lag the "
        "trade (up to ~45 days), amounts are reported as ranges, and a 'LATE' tag "
        "marks filings past the 45-day STOCK Act deadline. Treat as a slow, "
        "directional 'smart money' signal.",
        "",
    ]
    for r in rows[:30]:
        party = f", {r['party']}" if r["party"] else ""
        late = " · LATE" if r["is_late"] else ""
        parts.append(
            f"- [{r['chamber']}] {r['name']}{party}: {r['side'] or 'trade'} "
            f"· {r['amount'] or 'n/a'} · traded {r['date'] or '?'} "
            f"(disclosed {r['disclosed'] or '?'}){late}"
        )
    return "\n".join(parts)
