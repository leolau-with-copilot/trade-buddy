"""Global Markets terminal data — a macro 'decision dashboard' (not a data dump).

Backs the redesigned Markets page (Bloomberg/Koyfin-style). One module, many panels:
* ``regime``          — Growth / Inflation / Liquidity / Risk / Dollar narrative + scores,
* ``heatmap``         — per-country growth & inflation for the world choropleth (World Bank),
* ``indices``         — global equity indices (value · 1D · YTD · sparkline),
* ``bond_yields``     — 10Y govt yields (US daily + DE/UK/JP/IN via FRED),
* ``commodities``     — Gold/Silver/Copper/WTI/Brent/NatGas/Iron Ore/Wheat,
* ``fx``              — DXY + major pairs,
* ``risk``            — VIX, MOVE, HY spread,
* ``asset_flows``     — YTD performance by asset class (ETF proxy — real, sourceable),
* ``regional_macro``  — US/Eurozone/China/Japan/India: GDP/CPI/Unemp/Policy rate,
* ``calendar``        — upcoming economic events (Finnhub).

All sources are free/keyed and degrade to empty rather than raising. yfinance for
markets, World Bank for cross-country macro, FRED for rates, Finnhub for the calendar.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_TTL = 300
_cache: Dict[str, tuple] = {}
_lock = threading.Lock()


def _cached(key: str, fn, ttl: int = _TTL):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (now, val)
    return val


# --------------------------------------------------------------------------- #
# Symbol maps
# --------------------------------------------------------------------------- #
INDICES = [("^GSPC", "S&P 500", "US"), ("^IXIC", "NASDAQ 100", "US"),
           ("^STOXX50E", "Euro Stoxx 50", "EU"), ("^FTSE", "FTSE 100", "GB"),
           ("^N225", "Nikkei 225", "JP"), ("^HSI", "Hang Seng", "HK"),
           ("000300.SS", "CSI 300", "CN"), ("^NSEI", "India Nifty 50", "IN")]
FX = [("DX-Y.NYB", "DXY (Dollar Index)"), ("EURUSD=X", "EUR/USD"), ("USDJPY=X", "USD/JPY"),
      ("GBPUSD=X", "GBP/USD"), ("USDCNY=X", "USD/CNY"), ("AUDUSD=X", "AUD/USD"),
      ("USDCHF=X", "USD/CHF")]
COMMODITIES = [("GC=F", "Gold"), ("SI=F", "Silver"), ("HG=F", "Copper"),
               ("CL=F", "WTI Crude"), ("BZ=F", "Brent Crude"), ("NG=F", "Natural Gas"),
               ("TIO=F", "Iron Ore"), ("ZW=F", "Wheat")]
RISK_YF = [("^VIX", "VIX (Volatility)"), ("^MOVE", "MOVE Index (Rates Vol.)")]
# YTD asset-class flow proxies (replaces unsourceable fund-flow data).
ASSET_CLASSES = [("SPY", "US Equities"), ("EZU", "EU Equities"), ("EEM", "EM Equities"),
                 ("AGG", "US Bonds"), ("DBC", "Commodities"), ("GLD", "Gold")]
# 10Y govt bond yields: US is daily (yfinance ^TNX); the rest are monthly FRED/OECD.
BONDS_FRED = [("DE", "Germany", "IRLTLT01DEM156N"), ("GB", "UK", "IRLTLT01GBM156N"),
              ("JP", "Japan", "IRLTLT01JPM156N"), ("IN", "India", "INDIRLTLT01STM")]


def _download(symbols, period, interval):
    import yfinance as yf
    return yf.download(symbols, period=period, interval=interval,
                       auto_adjust=True, progress=False, threads=True)


def _close_vol(raw):
    if raw is None or getattr(raw, "empty", True):
        return None, None
    try:
        if hasattr(raw.columns, "levels"):
            return raw["Close"], (raw["Volume"] if "Volume" in raw.columns.get_level_values(0) else None)
        return raw[["Close"]], None
    except Exception:  # noqa: BLE001
        return None, None


def _yf_rows(symbols_map, *, period="1mo", want_ytd=False, spark_n=30) -> Dict[str, dict]:
    """Per-symbol {value, change_pct (1D), ytd_pct, spark[]} from one batch download."""
    syms = [s for s, *_ in symbols_map]
    try:
        closes, _ = _close_vol(_download(syms, period, "1d"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("yf panel download failed: %s", exc)
        closes = None
    out: Dict[str, dict] = {}
    if closes is None:
        return out
    yr_start = f"{date.today().year}-01-01"
    for sym in syms:
        if sym not in closes.columns:
            continue
        col = closes[sym].dropna()
        if len(col) < 2:
            continue
        last = float(col.iloc[-1]); prev = float(col.iloc[-2])
        row = {"value": round(last, 2),
               "change_pct": round((last / prev - 1) * 100, 2) if prev else None,
               "spark": [round(float(v), 4) for v in col.tail(spark_n)]}
        if want_ytd:
            try:
                ytd_col = col[col.index >= yr_start]
                base = float(ytd_col.iloc[0]) if len(ytd_col) else float(col.iloc[0])
                row["ytd_pct"] = round((last / base - 1) * 100, 2) if base else None
            except Exception:  # noqa: BLE001
                row["ytd_pct"] = None
        out[sym] = row
    return out


# --------------------------------------------------------------------------- #
# Equity indices · commodities · fx · risk
# --------------------------------------------------------------------------- #
def indices() -> Dict[str, Any]:
    data = _cached("g:indices", lambda: _yf_rows([(s,) for s, *_ in INDICES], period="1y", want_ytd=True))
    return {"rows": [dict(symbol=s, label=l, region=r, **data.get(s, {})) for s, l, r in INDICES if s in data]}


def commodities() -> Dict[str, Any]:
    data = _cached("g:cmd", lambda: _yf_rows([(s,) for s, _ in COMMODITIES], period="1mo"))
    return {"rows": [dict(symbol=s, label=l, **data.get(s, {})) for s, l in COMMODITIES if s in data]}


def fx() -> Dict[str, Any]:
    data = _cached("g:fx", lambda: _yf_rows([(s,) for s, _ in FX], period="1mo"))
    return {"rows": [dict(symbol=s, label=l, **data.get(s, {})) for s, l in FX if s in data]}


def risk() -> Dict[str, Any]:
    def build():
        rows = []
        yf_data = _yf_rows([(s,) for s, _ in RISK_YF], period="1mo")
        for s, l in RISK_YF:
            if s in yf_data:
                rows.append(dict(symbol=s, label=l, **yf_data[s]))
        # High-yield spread from FRED (percentage points)
        try:
            from tradingagents.dataflows import macro_utils
            d = macro_utils.indicator_latest("high_yield_spread")
            rows.append({"symbol": "HY", "label": "HY Credit Spread",
                         "value": round(float(d["value"]), 2) if d.get("value") is not None else None,
                         "change_pct": round(d["pct_change"], 2) if d.get("pct_change") is not None else None,
                         "spark": [p.get("value") for p in (d.get("history") or [])][-30:]})
        except Exception as exc:  # noqa: BLE001
            logger.warning("risk HY spread failed: %s", exc)
        return {"rows": rows}
    return _cached("g:risk", build)


def asset_flows() -> Dict[str, Any]:
    """YTD performance by asset class (ETF proxy) — the sourceable 'where's the money' panel."""
    def build():
        data = _yf_rows([(s,) for s, _ in ASSET_CLASSES], period="1y", want_ytd=True)
        rows = [dict(symbol=s, label=l, ytd_pct=data.get(s, {}).get("ytd_pct"))
                for s, l in ASSET_CLASSES if s in data]
        return {"rows": rows}
    return _cached("g:flows", build)


# --------------------------------------------------------------------------- #
# Bond yields (US daily + FRED monthly)
# --------------------------------------------------------------------------- #
def bond_yields() -> Dict[str, Any]:
    def build():
        rows = []
        # US 10Y — daily via ^TNX (reported as index = yield*? ^TNX is already in %).
        us = _yf_rows([("^TNX",)], period="1mo")
        if "^TNX" in us:
            r = us["^TNX"]
            rows.append({"code": "US", "label": "US", "yield": r["value"],
                         "change_bp": round((r["change_pct"] or 0) / 100 * r["value"] * 100, 1) if r.get("change_pct") else None,
                         "as_of": "live"})
        from tradingagents.dataflows import macro_utils
        for code, label, sid in BONDS_FRED:
            try:
                d = macro_utils.indicator_latest(sid)
                rows.append({"code": code, "label": label,
                             "yield": round(float(d["value"]), 2) if d.get("value") is not None else None,
                             "change_bp": round((d.get("change") or 0) * 100, 1) if d.get("change") is not None else None,
                             "as_of": d.get("as_of")})
            except Exception as exc:  # noqa: BLE001
                logger.warning("bond %s failed: %s", code, exc)
        return {"rows": rows}
    return _cached("g:bonds", build, ttl=900)


# --------------------------------------------------------------------------- #
# World Bank cross-country macro (heatmap + regional)
# --------------------------------------------------------------------------- #
_WB = {"growth": "NY.GDP.MKTP.KD.ZG", "inflation": "FP.CPI.TOTL.ZG", "unemployment": "SL.UEM.TOTL.ZS"}


def _wb_all(metric: str) -> Dict[str, dict]:
    """{iso3: {value, year, name}} for every country, latest non-empty (World Bank)."""
    def build():
        import requests
        ind = _WB[metric]
        rows, last_exc = None, None
        for _ in range(3):   # World Bank intermittently returns an empty/non-JSON body
            try:
                r = requests.get(f"https://api.worldbank.org/v2/country/all/indicator/{ind}",
                                 params={"format": "json", "per_page": 400, "mrnev": 1}, timeout=15)
                r.raise_for_status()
                body = r.json()
                rows = (body[1] or []) if isinstance(body, list) and len(body) > 1 else []
                break
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                time.sleep(0.6)
        if rows is None:
            logger.warning("world bank %s unavailable after retries: %s", metric, last_exc)
            return {}
        out = {}
        for x in rows:
            iso = x.get("countryiso3code")
            if iso and x.get("value") is not None:
                out[iso] = {"value": round(float(x["value"]), 1),
                            "year": x.get("date"), "name": (x.get("country") or {}).get("value")}
        return out
    return _cached(f"wb:{metric}", build, ttl=86400)  # annual data — cache a day


def heatmap() -> Dict[str, Any]:
    """Per-country growth + inflation for the world choropleth (latest annual)."""
    def build():
        g, i = _wb_all("growth"), _wb_all("inflation")
        codes = set(g) | set(i)
        rows = []
        for iso in codes:
            gv = g.get(iso, {}); iv = i.get(iso, {})
            if gv.get("value") is None and iv.get("value") is None:
                continue
            rows.append({"iso3": iso, "country": gv.get("name") or iv.get("name") or iso,
                         "growth": gv.get("value"), "inflation": iv.get("value"),
                         "year": gv.get("year") or iv.get("year")})
        return {"rows": rows, "source": "World Bank (latest annual)"}
    return _cached("g:heatmap", build, ttl=86400)


_REGIONS = [("USA", "United States", "US", "fed_funds"),
            ("EMU", "Eurozone", "EU", "ecb_deposit_rate"),
            ("CHN", "China", "CN", None),
            ("JPN", "Japan", "JP", "japan_policy_rate"),
            ("IND", "India", "IN", None),
            ("GBR", "United Kingdom", "GB", None),
            ("CAN", "Canada", "CA", None),
            ("KOR", "South Korea", "KR", None),
            ("BRA", "Brazil", "BR", None),
            ("AUS", "Australia", "AU", None)]


def regional_macro() -> Dict[str, Any]:
    def build():
        g, i, u = _wb_all("growth"), _wb_all("inflation"), _wb_all("unemployment")
        from tradingagents.dataflows import macro_utils
        rows = []
        for iso, name, code, rate_alias in _REGIONS:
            policy = None
            if rate_alias:
                try:
                    policy = macro_utils.indicator_latest(rate_alias).get("value")
                    policy = round(float(policy), 2) if policy is not None else None
                except Exception:  # noqa: BLE001
                    policy = None
            rows.append({"code": code, "name": name,
                         "gdp": g.get(iso, {}).get("value"),
                         "cpi": i.get(iso, {}).get("value"),
                         "unemployment": u.get(iso, {}).get("value"),
                         "policy_rate": policy})
        return {"rows": rows, "source": "World Bank · FRED policy rates"}
    return _cached("g:regional", build, ttl=3600)


# --------------------------------------------------------------------------- #
# Market regime composite (the narrative)
# --------------------------------------------------------------------------- #
def _clamp(x, lo=-1.0, hi=1.0):
    return max(lo, min(hi, x))


def regime() -> Dict[str, Any]:
    def build():
        cards = []
        g = _wb_all("growth").get("USA", {}).get("value")
        infl = _wb_all("inflation").get("USA", {}).get("value")
        # Growth
        if g is not None:
            status = "Expansion" if g >= 2.5 else "Moderate" if g >= 1 else "Slowdown" if g >= 0 else "Contraction"
            cards.append({"key": "Growth", "status": status, "score": round(_clamp((g - 1.5) / 2), 1)})
        # Inflation
        if infl is not None:
            status = "Elevated" if infl > 3 else "Moderating" if infl >= 2 else "Low"
            cards.append({"key": "Inflation", "status": status, "score": round(_clamp((infl - 2) / 2), 1)})
        # Liquidity — direction of the fed funds rate over ~6 months
        try:
            from tradingagents.dataflows import macro_utils
            s = macro_utils.indicator_series("fed_funds", max_points=12).get("points", [])
            if len(s) >= 6:
                delta = float(s[-1]["value"]) - float(s[-6]["value"])
                status = "Improving" if delta < -0.1 else "Tightening" if delta > 0.1 else "Stable"
                cards.append({"key": "Liquidity", "status": status, "score": round(_clamp(-delta), 1)})
        except Exception as exc:  # noqa: BLE001
            logger.warning("regime liquidity failed: %s", exc)
        # Risk appetite + Dollar — from live VIX & DXY
        try:
            yd = _yf_rows([("^VIX",), ("DX-Y.NYB",)], period="6mo")
            vix = yd.get("^VIX", {}).get("value")
            if vix is not None:
                status = "Risk-On" if vix < 18 else "Neutral" if vix <= 25 else "Risk-Off"
                cards.append({"key": "Risk Appetite", "status": status, "score": round(_clamp((20 - vix) / 15), 1)})
            dxy = yd.get("DX-Y.NYB", {})
            spark = dxy.get("spark") or []
            if dxy.get("value") and len(spark) >= 2 and spark[0]:
                mom = (dxy["value"] / spark[0] - 1) * 100
                status = "Strong" if mom > 2 else "Weak" if mom < -2 else "Neutral"
                cards.append({"key": "Dollar", "status": status, "score": round(_clamp(mom / 5), 1)})
        except Exception as exc:  # noqa: BLE001
            logger.warning("regime risk/dollar failed: %s", exc)
        return {"cards": cards}
    return _cached("g:regime", build, ttl=900)


# --------------------------------------------------------------------------- #
# Economic calendar (Finnhub)
# --------------------------------------------------------------------------- #
_CAL_COUNTRIES = {"US", "EU", "EZ", "CN", "JP", "GB", "DE", "IN"}


def calendar(days: int = 7) -> Dict[str, Any]:
    def build():
        token = os.environ.get("FINNHUB_API_KEY")
        if not token:
            return {"rows": [], "error": "Economic calendar needs a Finnhub key."}
        import requests
        today = date.today()
        try:
            r = requests.get("https://finnhub.io/api/v1/calendar/economic",
                             params={"token": token, "from": today.isoformat(),
                                     "to": (today + timedelta(days=days)).isoformat()}, timeout=15)
            r.raise_for_status()
            events = (r.json() or {}).get("economicCalendar", []) or []
        except Exception as exc:  # noqa: BLE001
            logger.warning("econ calendar failed: %s", exc)
            return {"rows": []}
        rows = []
        for e in events:
            c = (e.get("country") or "").upper()
            if c not in _CAL_COUNTRIES:
                continue
            if (e.get("impact") or "").lower() == "low":
                continue
            rows.append({"date": (e.get("time") or "")[:10], "time": e.get("time"),
                         "country": c, "event": e.get("event"), "impact": e.get("impact"),
                         "estimate": e.get("estimate"), "prev": e.get("prev"), "actual": e.get("actual")})
        rows.sort(key=lambda x: x.get("time") or "")
        return {"rows": rows[:24]}
    return _cached("g:calendar", build, ttl=1800)
