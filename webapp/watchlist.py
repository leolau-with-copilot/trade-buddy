"""Watchlist: persist favorite tickers and serve them with live quotes.

No user accounts yet — a single shared watchlist is stored as JSON under the
data cache dir. Each listed symbol is enriched concurrently with a live price,
day change, and a short close-series sparkline so the UI can render a row like
the mockup (symbol · name · sparkline · price · %change).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import List

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()


def _path() -> str:
    from tradingagents.dataflows.config import get_config

    cache_dir = get_config().get("data_cache_dir", ".")
    os.makedirs(cache_dir, exist_ok=True)
    return os.path.join(cache_dir, "watchlist.json")


def load() -> List[str]:
    """Return the stored symbols (upper-case, de-duped, order preserved)."""
    try:
        with open(_path(), encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, list):
            return [str(s).upper() for s in data]
    except FileNotFoundError:
        return []
    except Exception as exc:  # noqa: BLE001 — corrupt file
        logger.warning("watchlist read failed: %s", exc)
    return []


def _save(symbols: List[str]) -> None:
    with open(_path(), "w", encoding="utf-8") as fh:
        json.dump(symbols, fh)


def add(symbol: str) -> List[str]:
    symbol = symbol.strip().upper()
    if not symbol:
        return load()
    with _LOCK:
        symbols = load()
        if symbol not in symbols:
            symbols.append(symbol)
            _save(symbols)
        return symbols


def remove(symbol: str) -> List[str]:
    symbol = symbol.strip().upper()
    with _LOCK:
        symbols = [s for s in load() if s != symbol]
        _save(symbols)
        return symbols


def _enrich_one(symbol: str) -> dict:
    """Live price, day change, and a 30-point close sparkline for one symbol."""
    from webapp import quote as quote_mod

    row = {"symbol": symbol, "name": "", "price": None, "change_pct": None, "spark": []}
    try:
        q = quote_mod.quote(symbol)
        row["name"] = q.get("name") or symbol
        row["price"] = q.get("price")
        row["change_pct"] = q.get("change_1d") if q.get("change_1d") is not None else q.get("change_pct")
    except Exception as exc:  # noqa: BLE001
        logger.warning("watchlist quote %s failed: %s", symbol, exc)
    try:
        df = quote_mod._ohlcv(symbol)
        row["spark"] = [round(float(c), 4) for c in df["Close"].tail(30).tolist()]
    except Exception:  # noqa: BLE001
        pass
    return row


def enriched() -> List[dict]:
    """Return every watchlist symbol with a live quote + sparkline, concurrently."""
    symbols = load()
    if not symbols:
        return []
    with ThreadPoolExecutor(max_workers=min(8, len(symbols))) as pool:
        rows = list(pool.map(_enrich_one, symbols))
    # Preserve stored order.
    order = {s: i for i, s in enumerate(symbols)}
    rows.sort(key=lambda r: order.get(r["symbol"], 1e9))
    return rows
