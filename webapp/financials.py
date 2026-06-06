"""Quarterly financial statements + fundamental key-signals for the dashboard.

Powers two UI pieces (one fetch):
* the **Quarterly Financials** histogram — Revenue / Operating Profit / Net Income
  over the last 5 quarters (bars = amount, with a QoQ % change line), and
* the fundamental half of the **Key Signals** panel — EPS (TTM + latest quarter),
  ROE/ROA, profit/gross margin, revenue & earnings growth.

All figures come from yfinance (quarterly income statement + the ticker's info
block). yfinance only carries ~5 quarters, so YoY across every bar isn't
possible — the change line is quarter-over-quarter (see the dashboard note).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import yfinance as yf

from tradingagents.dataflows.stockstats_utils import yf_retry

logger = logging.getLogger(__name__)


def _row(df, *names):
    """First matching row (a pandas Series) for any of ``names``, else None."""
    if df is None or getattr(df, "empty", True):
        return None
    for n in names:
        if n in df.index:
            return df.loc[n]
    return None


def _num(series, col) -> Optional[float]:
    """A clean float from ``series[col]`` or None (NaN/missing → None)."""
    if series is None:
        return None
    try:
        v = series.get(col)
    except Exception:  # noqa: BLE001
        return None
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f  # drop NaN


def _pct(x: Optional[float]) -> str:
    return "—" if x is None else f"{x * 100:.1f}%"


def _verdict(x: Optional[float], good: float, bad: float = 0.0) -> str:
    """bullish if x ≥ good, bearish if x < bad, else neutral."""
    if x is None:
        return "neutral"
    if x >= good:
        return "bullish"
    if x < bad:
        return "bearish"
    return "neutral"


def financials(ticker: str) -> Dict[str, Any]:
    """Histogram series (5 quarters) + fundamental signal rows for ``ticker``."""
    sym = (ticker or "").strip().upper()
    out: Dict[str, Any] = {"ticker": sym, "quarters": [], "signals": []}
    if not sym:
        return out

    t = yf.Ticker(sym)
    try:
        q = yf_retry(lambda: t.quarterly_income_stmt)
    except Exception as exc:  # noqa: BLE001
        logger.warning("financials income stmt failed for %s: %s", sym, exc)
        q = None

    rev = _row(q, "Total Revenue", "Operating Revenue")
    opi = _row(q, "Operating Income", "Operating Income Or Loss")
    ni = _row(q, "Net Income", "Net Income Common Stockholders")
    eps = _row(q, "Basic EPS", "Diluted EPS")
    gp = _row(q, "Gross Profit")

    cols = sorted(q.columns) if q is not None and not q.empty else []  # oldest→newest
    for c in cols:
        out["quarters"].append({
            "date": str(getattr(c, "date", lambda: c)()),
            "revenue": _num(rev, c),
            "operating_income": _num(opi, c),
            "net_income": _num(ni, c),
        })

    # --- fundamental signals (TTM ratios from .info, EPS from statements) ----
    try:
        info = t.info or {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("financials info failed for %s: %s", sym, exc)
        info = {}

    last = cols[-1] if cols else None
    eps_latest = _num(eps, last) if last is not None else None
    eps_ttm = info.get("trailingEps")
    roe = info.get("returnOnEquity")
    roa = info.get("returnOnAssets")
    pmargin = info.get("profitMargins")
    gmargin = info.get("grossMargins")
    if gmargin is None and gp is not None and rev is not None and last is not None:
        g, r = _num(gp, last), _num(rev, last)
        gmargin = (g / r) if (g is not None and r) else None
    rev_growth = info.get("revenueGrowth")
    earn_growth = info.get("earningsQuarterlyGrowth")

    def money_eps(x):
        return "—" if x is None else f"{x:.2f}"

    out["signals"] = [
        {"label": "EPS (TTM)", "value": money_eps(eps_ttm),
         "verdict": _verdict(eps_ttm, 0.0001, 0.0)},
        {"label": "EPS (latest qtr)", "value": money_eps(eps_latest),
         "verdict": _verdict(eps_latest, 0.0001, 0.0)},
        {"label": "Return on Equity", "value": _pct(roe),
         "verdict": _verdict(roe, 0.15, 0.0)},
        {"label": "Return on Assets", "value": _pct(roa),
         "verdict": _verdict(roa, 0.05, 0.0)},
        {"label": "Profit Margin", "value": _pct(pmargin),
         "verdict": _verdict(pmargin, 0.10, 0.0)},
        {"label": "Gross Margin", "value": _pct(gmargin),
         "verdict": _verdict(gmargin, 0.40, 0.0)},
        {"label": "Revenue Growth (YoY)", "value": _pct(rev_growth),
         "verdict": _verdict(rev_growth, 0.05, 0.0)},
        {"label": "Earnings Growth (YoY)", "value": _pct(earn_growth),
         "verdict": _verdict(earn_growth, 0.05, 0.0)},
    ]
    return out
