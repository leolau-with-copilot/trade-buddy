"""Company analysis data for the OpenBB-style AI Analysis workspace.

One module backing the left-pane tabs of the AI Analysis page:
* ``overview``   — description, profile, price snapshot, estimate + calendar summary,
* ``estimates``  — analyst price targets, recommendation tally, EPS/revenue/growth estimates,
* ``calendar``   — upcoming & past earnings dates, recent dividends, splits,
* ``ownership``  — institutional & major holders, recent insider transactions,
* ``peers``      — peer tickers (Finnhub) with a live quote/metric for each.

All yfinance-backed (free) except ``peers`` which uses the Finnhub key for the peer
list. Everything is defensive: a missing field or a yfinance-version quirk yields a
null/empty section rather than raising, so a tab always renders.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_info_cache: Dict[str, tuple] = {}      # symbol -> (ts, info dict)
_INFO_TTL = 600
_lock = threading.Lock()


def _ticker(sym: str):
    import yfinance as yf
    return yf.Ticker(sym)


def _info(sym: str) -> dict:
    """Cached ``.info`` for a ticker (the slow Yahoo profile call)."""
    hit = _info_cache.get(sym)
    if hit and time.time() - hit[0] < _INFO_TTL:
        return hit[1]
    try:
        info = _ticker(sym).info or {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("info(%s) failed: %s", sym, exc)
        info = {}
    with _lock:
        _info_cache[sym] = (time.time(), info)
    return info


def _f(v) -> Optional[float]:
    """Clean float or None (drops NaN)."""
    try:
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None


def _df_records(df, index_name="period", limit=None):
    """JSON-safe records from a DataFrame (Timestamps → ISO, NaN → None)."""
    import pandas as pd
    if df is None or not isinstance(df, pd.DataFrame) or df.empty:
        return []
    rows = df.tail(limit) if limit else df
    recs = []
    for idx, row in rows.iterrows():
        rec = {index_name: (idx.strftime("%Y-%m-%d") if isinstance(idx, pd.Timestamp) else str(idx))}
        for col, val in row.items():
            if isinstance(val, pd.Timestamp):
                rec[str(col)] = val.strftime("%Y-%m-%d")
            elif val is None or (isinstance(val, float) and val != val):
                rec[str(col)] = None
            else:
                fv = _f(val)
                rec[str(col)] = fv if fv is not None else str(val)
        recs.append(rec)
    return recs


# --------------------------------------------------------------------------- #
# Overview
# --------------------------------------------------------------------------- #
def overview(ticker: str) -> Dict[str, Any]:
    """Company description, profile, price snapshot + a compact estimate/calendar summary."""
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"error": "Provide a ticker."}
    info = _info(sym)
    profile = {
        "name": info.get("longName") or info.get("shortName") or sym,
        "description": info.get("longBusinessSummary"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "website": info.get("website"),
        "employees": info.get("fullTimeEmployees"),
        "country": info.get("country"),
        "city": info.get("city"),
        "exchange": info.get("exchange") or info.get("fullExchangeName"),
        "market_cap": _f(info.get("marketCap")),
        "currency": info.get("currency"),
    }
    price = {
        "last": _f(info.get("currentPrice") or info.get("regularMarketPrice")),
        "change_pct": _f(info.get("regularMarketChangePercent")),
        "prev_close": _f(info.get("previousClose")),
        "day_high": _f(info.get("dayHigh")),
        "day_low": _f(info.get("dayLow")),
        "fifty_two_high": _f(info.get("fiftyTwoWeekHigh")),
        "fifty_two_low": _f(info.get("fiftyTwoWeekLow")),
        "pe": _f(info.get("trailingPE")),
        "forward_pe": _f(info.get("forwardPE")),
        "dividend_yield": _f(info.get("dividendYield")),
        "beta": _f(info.get("beta")),
    }
    # compact summaries pulled from the dedicated builders (best-effort)
    est = estimates(sym)
    cal = calendar(sym)
    return {
        "ticker": sym, "profile": profile, "price": price,
        "estimate_summary": est.get("price_target"),
        "recommendation": est.get("recommendation"),
        "calendar_summary": cal.get("next"),
        "source": "Yahoo Finance",
    }


# --------------------------------------------------------------------------- #
# Estimates
# --------------------------------------------------------------------------- #
def estimates(ticker: str) -> Dict[str, Any]:
    """Analyst price targets, recommendation tally, and EPS/revenue/growth estimates."""
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"error": "Provide a ticker."}
    t = _ticker(sym)

    pt = None
    try:
        raw = t.analyst_price_targets or {}
        if raw:
            pt = {k: _f(v) for k, v in raw.items()}
    except Exception as exc:  # noqa: BLE001
        logger.warning("price targets(%s) failed: %s", sym, exc)

    rec = None
    try:
        rdf = t.recommendations
        recs = _df_records(rdf, "period")
        if recs:
            r0 = recs[0]  # most recent period ("0m")
            rec = {k: r0.get(k) for k in ("strongBuy", "buy", "hold", "sell", "strongSell")}
    except Exception as exc:  # noqa: BLE001
        logger.warning("recommendations(%s) failed: %s", sym, exc)

    def grab(attr, idx_name="period"):
        try:
            return _df_records(getattr(t, attr), idx_name)
        except Exception as exc:  # noqa: BLE001
            logger.warning("%s(%s) failed: %s", attr, sym, exc)
            return []

    return {
        "ticker": sym,
        "price_target": pt,
        "recommendation": rec,
        "earnings_estimate": grab("earnings_estimate"),
        "revenue_estimate": grab("revenue_estimate"),
        "eps_trend": grab("eps_trend"),
        "growth_estimates": grab("growth_estimates"),
        "source": "Yahoo Finance",
    }


# --------------------------------------------------------------------------- #
# Company calendar
# --------------------------------------------------------------------------- #
def calendar(ticker: str) -> Dict[str, Any]:
    """Next earnings/dividend dates plus recent earnings history, dividends, splits."""
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"error": "Provide a ticker."}
    t = _ticker(sym)

    nxt = {}
    try:
        cal = t.calendar or {}
        def d(v):
            if isinstance(v, (list, tuple)):
                v = v[0] if v else None
            return v.strftime("%Y-%m-%d") if hasattr(v, "strftime") else (str(v) if v else None)
        nxt = {
            "earnings_date": d(cal.get("Earnings Date")),
            "ex_dividend_date": d(cal.get("Ex-Dividend Date")),
            "dividend_date": d(cal.get("Dividend Date")),
            "earnings_avg": _f(cal.get("Earnings Average")),
            "revenue_avg": _f(cal.get("Revenue Average")),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("calendar(%s) failed: %s", sym, exc)

    earnings_hist = []
    try:
        ed = t.earnings_dates
        recs = _df_records(ed, "date", limit=12)
        earnings_hist = list(reversed(recs))  # newest first
    except Exception as exc:  # noqa: BLE001
        logger.warning("earnings_dates(%s) failed: %s", sym, exc)

    def series_recent(attr, n=12):
        try:
            s = getattr(t, attr)
            if s is None or s.empty:
                return []
            return [{"date": idx.strftime("%Y-%m-%d"), "value": _f(v)}
                    for idx, v in s.tail(n).items()][::-1]
        except Exception as exc:  # noqa: BLE001
            logger.warning("%s(%s) failed: %s", attr, sym, exc)
            return []

    return {
        "ticker": sym, "next": nxt,
        "earnings_history": earnings_hist,
        "dividends": series_recent("dividends"),
        "splits": series_recent("splits", 8),
        "source": "Yahoo Finance",
    }


# --------------------------------------------------------------------------- #
# Ownership
# --------------------------------------------------------------------------- #
def ownership(ticker: str) -> Dict[str, Any]:
    """Institutional holders, major-holder breakdown, and recent insider transactions."""
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"error": "Provide a ticker."}
    t = _ticker(sym)

    institutional = []
    try:
        idf = t.institutional_holders
        for r in _df_records(idf, "i"):
            institutional.append({
                "holder": r.get("Holder"),
                "shares": r.get("Shares"),
                "pct_held": r.get("pctHeld"),
                "value": r.get("Value"),
                "pct_change": r.get("pctChange"),
                "date": r.get("Date Reported"),
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning("institutional(%s) failed: %s", sym, exc)

    major = {}
    try:
        mdf = t.major_holders
        # index = breakdown label, single "Value" column
        for idx, row in mdf.iterrows():
            major[str(idx)] = _f(row.get("Value"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("major_holders(%s) failed: %s", sym, exc)

    insiders = []
    try:
        for r in _df_records(t.insider_transactions, "i")[:20]:
            insiders.append({
                "insider": r.get("Insider"),
                "position": r.get("Position"),
                "transaction": r.get("Text"),
                "shares": r.get("Shares"),
                "value": r.get("Value"),
                "date": r.get("Start Date") or r.get("Date"),
                "url": r.get("URL"),
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning("insiders(%s) failed: %s", sym, exc)

    return {"ticker": sym, "institutional": institutional, "major": major,
            "insiders": insiders, "source": "Yahoo Finance"}


# --------------------------------------------------------------------------- #
# Comparison / peers
# --------------------------------------------------------------------------- #
def peers(ticker: str) -> Dict[str, Any]:
    """Peer tickers (Finnhub) with a live quote + key metric for each (comparison table)."""
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"error": "Provide a ticker."}

    syms: List[str] = []
    token = os.environ.get("FINNHUB_API_KEY")
    if token:
        import requests
        try:
            r = requests.get("https://finnhub.io/api/v1/stock/peers",
                             params={"symbol": sym, "token": token}, timeout=10)
            r.raise_for_status()
            syms = [s.upper() for s in (r.json() or []) if s]
        except Exception as exc:  # noqa: BLE001
            logger.warning("peers(%s) failed: %s", sym, exc)
    if sym not in syms:
        syms = [sym] + syms
    syms = syms[:10]
    if len(syms) <= 1:
        return {"ticker": sym, "rows": [],
                "error": "No peer data available (needs a Finnhub key)."}

    rows = []
    for s in syms:
        info = _info(s)
        rows.append({
            "symbol": s,
            "name": info.get("shortName") or info.get("longName") or s,
            "price": _f(info.get("currentPrice") or info.get("regularMarketPrice")),
            "change_pct": _f(info.get("regularMarketChangePercent")),
            "market_cap": _f(info.get("marketCap")),
            "pe": _f(info.get("trailingPE")),
            "profit_margin": _f(info.get("profitMargins")),
            "revenue_growth": _f(info.get("revenueGrowth")),
            "is_target": s == sym,
        })
    return {"ticker": sym, "rows": rows, "source": "Finnhub peers · Yahoo metrics"}
