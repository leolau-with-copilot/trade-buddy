"""Market overview data for the news terminal: indices, movers, sectors.

Backs the Bloomberg-style News page widgets:
* ``indices(range)``  — normalized %-change lines for S&P 500 / Nasdaq / Dow
  (the multi-series "Market Indices" chart),
* ``movers()``        — top gainers / losers / most-active from a liquid
  large-cap universe,
* ``sectors(range)``  — sector performance via the SPDR sector ETFs.

All three are yfinance-backed with a short TTL cache so the page is snappy and
we don't re-download on every load. Everything degrades to empty rather than
raising, so a vendor hiccup never breaks the page.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Dict, List

logger = logging.getLogger(__name__)

# yfinance range -> (period, interval) for the line charts.
_RANGE_MAP = {
    "1d": ("1d", "5m"), "5d": ("5d", "30m"), "1m": ("1mo", "1d"),
    "6m": ("6mo", "1d"), "ytd": ("ytd", "1d"), "1y": ("1y", "1d"),
    "5y": ("5y", "1wk"),
}

_INDICES = [("^GSPC", "S&P 500"), ("^IXIC", "NASDAQ 100"), ("^DJI", "DOW JONES")]

# SPDR sector ETFs → sector name, ordered as on a sector board.
_SECTORS = [
    ("XLK", "Technology"), ("XLC", "Communication Services"),
    ("XLY", "Consumer Discretionary"), ("XLI", "Industrials"),
    ("XLF", "Financials"), ("XLP", "Consumer Staples"),
    ("XLU", "Utilities"), ("XLE", "Energy"),
    ("XLV", "Healthcare"), ("XLB", "Materials"), ("XLRE", "Real Estate"),
]

# Liquid large-cap universe for the movers board (kept small so one batch
# download is cheap; covers the names a markets desk actually watches).
_MOVERS_UNIVERSE = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "AVGO",
    "NFLX", "INTC", "QCOM", "CRM", "ADBE", "ORCL", "CSCO", "PEP", "KO",
    "JPM", "BAC", "WFC", "GS", "V", "MA", "DIS", "BA", "XOM", "CVX",
    "PFE", "JNJ", "UNH", "WMT", "HD", "MCD", "NKE", "COST", "PYPL", "UBER",
    "PLTR", "SHOP", "COIN", "MU", "ARM", "SMCI", "DELL", "F", "GM", "T",
]

_TTL = 120
_cache: Dict[str, tuple] = {}
_lock = threading.Lock()


def _cached(key: str, fn):
    """Memoize ``fn()`` under ``key`` for ``_TTL`` seconds."""
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (now, val)
    return val


def _download(tickers, period, interval):
    import yfinance as yf
    return yf.download(tickers, period=period, interval=interval,
                       auto_adjust=True, progress=False, threads=True)


def _close_frame(raw):
    """Pull the Close columns out of a yfinance multi-ticker download frame."""
    if raw is None or getattr(raw, "empty", True):
        return None
    try:
        if hasattr(raw.columns, "levels"):       # MultiIndex (multi-ticker)
            return raw["Close"]
        return raw[["Close"]]                     # single ticker
    except Exception:  # noqa: BLE001
        return None


def indices(rng: str = "1d") -> Dict:
    """Normalized %-change series for the major indices over ``rng``."""
    rng = rng if rng in _RANGE_MAP else "1d"
    return _cached(f"idx:{rng}", lambda: _indices_uncached(rng))


def _indices_uncached(rng: str) -> Dict:
    period, interval = _RANGE_MAP[rng]
    syms = [s for s, _ in _INDICES]
    try:
        closes = _close_frame(_download(syms, period, interval))
    except Exception as exc:  # noqa: BLE001
        logger.warning("indices download failed: %s", exc)
        closes = None
    series: List[dict] = []
    if closes is not None:
        for sym, label in _INDICES:
            if sym not in closes.columns:
                continue
            col = closes[sym].dropna()
            if col.empty:
                continue
            base = float(col.iloc[0])
            if base == 0:
                continue
            points = [{"t": int(ts.timestamp()), "v": round((float(v) / base - 1) * 100, 3)}
                      for ts, v in col.items()]
            last = float(col.iloc[-1])
            series.append({
                "symbol": sym, "label": label, "points": points,
                "last": round(last, 2),
                "change_pct": round((last / base - 1) * 100, 2),
            })
    return {"range": rng, "series": series}


def sectors(rng: str = "1d") -> Dict:
    """Sector performance (% change over ``rng``) from the SPDR sector ETFs."""
    rng = rng if rng in _RANGE_MAP else "1d"
    return _cached(f"sec:{rng}", lambda: _sectors_uncached(rng))


def _sectors_uncached(rng: str) -> Dict:
    period, interval = _RANGE_MAP[rng]
    syms = [s for s, _ in _SECTORS]
    try:
        closes = _close_frame(_download(syms, period, interval))
    except Exception as exc:  # noqa: BLE001
        logger.warning("sectors download failed: %s", exc)
        closes = None
    rows: List[dict] = []
    if closes is not None:
        for sym, name in _SECTORS:
            if sym not in closes.columns:
                continue
            col = closes[sym].dropna()
            if len(col) < 2:
                continue
            base, last = float(col.iloc[0]), float(col.iloc[-1])
            if base == 0:
                continue
            rows.append({"symbol": sym, "sector": name,
                         "change_pct": round((last / base - 1) * 100, 2)})
    rows.sort(key=lambda r: r["change_pct"], reverse=True)
    return {"range": rng, "rows": rows}


def movers() -> Dict:
    """Top gainers / losers / most-active from the large-cap universe (1-day)."""
    return _cached("movers", _movers_uncached)


def _movers_uncached() -> Dict:
    try:
        raw = _download(_MOVERS_UNIVERSE, "2d", "1d")
    except Exception as exc:  # noqa: BLE001
        logger.warning("movers download failed: %s", exc)
        return {"gainers": [], "losers": [], "active": []}

    closes = _close_frame(raw)
    vols = None
    try:
        vols = raw["Volume"] if hasattr(raw.columns, "levels") else None
    except Exception:  # noqa: BLE001
        vols = None
    if closes is None:
        return {"gainers": [], "losers": [], "active": []}

    rows: List[dict] = []
    for sym in _MOVERS_UNIVERSE:
        if sym not in closes.columns:
            continue
        col = closes[sym].dropna()
        if len(col) < 2:
            continue
        prev, last = float(col.iloc[-2]), float(col.iloc[-1])
        if prev == 0:
            continue
        vol = 0
        if vols is not None and sym in vols.columns:
            v = vols[sym].dropna()
            vol = int(v.iloc[-1]) if not v.empty else 0
        rows.append({"symbol": sym, "price": round(last, 2),
                     "change_pct": round((last / prev - 1) * 100, 2), "volume": vol})

    gainers = sorted(rows, key=lambda r: r["change_pct"], reverse=True)[:6]
    losers = sorted(rows, key=lambda r: r["change_pct"])[:6]
    active = sorted(rows, key=lambda r: r["volume"], reverse=True)[:6]
    return {"gainers": gainers, "losers": losers, "active": active}
