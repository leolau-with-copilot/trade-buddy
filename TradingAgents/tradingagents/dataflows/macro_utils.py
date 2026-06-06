"""Macro-economic data for the news/macro analyst — FRED-centric.

The redesigned pipeline's macro analyst previously had only free-text news. This
module gives it *structured* macro series: interest rates, inflation, growth,
labor, and key international indicators.

FRED (Federal Reserve Economic Data) is the backbone: it not only carries US
series but also re-publishes ECB, OECD, and IMF series, so a single reliable
integration covers the FRED/IMF/OECD/ECB cluster. Two access modes:

* **Keyed** — when ``FRED_API_KEY`` is set, the official JSON API
  (``api.stlouisfed.org/fred/series/observations``) is used (matches the OpenBB
  ``federal_reserve`` provider spec).
* **Keyless** — otherwise the public ``fredgraph.csv`` endpoint is used, which
  needs no key. Works out of the box; the key just adds metadata/robustness.

Everything degrades to a clear string rather than raising.
"""

from __future__ import annotations

import io
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout, as_completed
from datetime import datetime
from typing import Annotated, Optional

import pandas as pd
import requests

logger = logging.getLogger(__name__)

_FRED_API = "https://api.stlouisfed.org/fred/series/observations"
_FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv"
_TIMEOUT = 20
# The snapshot fetches the whole basket at once, so use a tighter per-request
# timeout (a single slow series shouldn't stall the table) plus an overall
# deadline across all series, and cache the rendered result — macro data moves
# slowly, so re-hitting FRED on every page load / agent call is wasteful and is
# what produces the repeated read-timeout warnings.
_SNAPSHOT_TIMEOUT = 8
_SNAPSHOT_DEADLINE = 12.0
_SNAPSHOT_TTL = 900.0   # 15 min
_snapshot_cache: dict[str, tuple[float, str]] = {}
_snapshot_lock = threading.Lock()

# Friendly aliases → FRED series IDs. Covers the most market-relevant macro
# series across the FRED/IMF/OECD/ECB cluster. The LLM may also pass a raw FRED
# series id directly (anything not in this map is used as-is).
INDICATOR_ALIASES = {
    # US rates
    "fed_funds": "FEDFUNDS",
    "fed_funds_target_upper": "DFEDTARU",
    "10y_treasury": "DGS10",
    "2y_treasury": "DGS2",
    "3m_treasury": "DGS3MO",
    "10y_2y_spread": "T10Y2Y",
    "real_10y": "DFII10",
    # US inflation
    "cpi": "CPIAUCSL",
    "core_cpi": "CPILFESL",
    "pce": "PCEPI",
    "core_pce": "PCEPILFE",
    "inflation_expectations_5y": "T5YIE",
    "breakeven_10y": "T10YIE",
    # US growth / activity
    "gdp": "GDPC1",
    "gdp_nominal": "GDP",
    "industrial_production": "INDPRO",
    "retail_sales": "RSAFS",
    "ism_manufacturing": "MANEMP",
    # US labor
    "unemployment": "UNRATE",
    "nonfarm_payrolls": "PAYEMS",
    "initial_claims": "ICSA",
    "labor_participation": "CIVPART",
    # Financial conditions / markets
    "vix": "VIXCLS",
    "high_yield_spread": "BAMLH0A0HYM2",
    "dollar_index": "DTWEXBGS",
    "wti_oil": "DCOILWTICO",
    "m2": "M2SL",
    # International (FRED-mirrored ECB / OECD)
    "ecb_deposit_rate": "ECBDFR",
    "ecb_main_refi_rate": "ECBMRRFR",
    "euro_area_cpi": "CP0000EZ19M086NEST",
    "china_gdp_growth": "MKTGDPCNA646NWDB",
    "uk_bank_rate": "BOERUKM",
    "japan_policy_rate": "INTDSRJPM193N",
    "eur_usd": "DEXUSEU",
    "usd_cny": "DEXCHUS",
    "usd_jpy": "DEXJPUS",
}

# Default basket for the one-call macro snapshot.
_SNAPSHOT = [
    "fed_funds", "10y_treasury", "10y_2y_spread", "cpi", "core_pce",
    "unemployment", "nonfarm_payrolls", "gdp", "vix", "high_yield_spread",
    "wti_oil", "dollar_index",
]


def _resolve_series(indicator: str) -> str:
    """Map a friendly alias to a FRED series id, or pass through a raw id."""
    return INDICATOR_ALIASES.get(indicator.strip().lower(), indicator.strip())


def _fetch_fred_csv(series_id: str, start: Optional[str], end: Optional[str],
                    timeout: int = _TIMEOUT) -> pd.DataFrame:
    """Keyless fetch via fredgraph.csv. Returns a (date, value) DataFrame."""
    params = {"id": series_id}
    if start:
        params["cosd"] = start
    if end:
        params["coed"] = end
    resp = requests.get(_FRED_CSV, params=params, timeout=timeout)
    resp.raise_for_status()
    df = pd.read_csv(io.StringIO(resp.text))
    df.columns = ["date", "value"]
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df.dropna(subset=["value"])


def _fetch_fred_api(series_id: str, start: Optional[str], end: Optional[str], key: str,
                    timeout: int = _TIMEOUT) -> pd.DataFrame:
    """Keyed fetch via the official FRED JSON API."""
    params = {"series_id": series_id, "api_key": key, "file_type": "json"}
    if start:
        params["observation_start"] = start
    if end:
        params["observation_end"] = end
    resp = requests.get(_FRED_API, params=params, timeout=timeout)
    resp.raise_for_status()
    obs = resp.json().get("observations", [])
    df = pd.DataFrame([(o["date"], o["value"]) for o in obs], columns=["date", "value"])
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df.dropna(subset=["value"])


def _fetch_series(series_id: str, start: Optional[str], end: Optional[str],
                  timeout: int = _TIMEOUT) -> pd.DataFrame:
    key = os.environ.get("FRED_API_KEY")
    if key:
        try:
            return _fetch_fred_api(series_id, start, end, key, timeout)
        except Exception as e:  # fall back to keyless on any API error
            logger.warning("FRED API failed for %s (%s); using keyless CSV.", series_id, e)
    return _fetch_fred_csv(series_id, start, end, timeout)


def indicator_latest(indicator: str, timeout: int = _TIMEOUT) -> dict:
    """Return the latest structured reading for ``indicator`` (alias or series id).

    ``{indicator, series, value, as_of, prev, change, pct_change, history}`` where
    ``history`` is the last ~24 (date, value) points for a sparkline. Raises on
    fetch failure so callers can decide how to degrade. ``timeout`` lets batch
    callers (dashboard cards) use a tighter per-request budget than the default.
    """
    series_id = _resolve_series(indicator)
    df = _fetch_series(series_id, None, None, timeout=timeout)
    if df.empty:
        return {"indicator": indicator, "series": series_id, "value": None,
                "as_of": None, "prev": None, "change": None, "pct_change": None,
                "history": []}
    latest = df.iloc[-1]
    prev = df.iloc[-2] if len(df) >= 2 else None
    change = (latest["value"] - prev["value"]) if prev is not None else None
    pct = (change / prev["value"] * 100.0) if (prev is not None and prev["value"]) else None
    hist = [
        {"date": str(r["date"]), "value": float(r["value"])}
        for _, r in df.tail(24).iterrows()
    ]
    return {
        "indicator": indicator,
        "series": series_id,
        "value": float(latest["value"]),
        "as_of": str(latest["date"]),
        "prev": float(prev["value"]) if prev is not None else None,
        "change": float(change) if change is not None else None,
        "pct_change": float(pct) if pct is not None else None,
        "history": hist,
    }


def indicator_series(indicator: str, max_points: int = 240) -> dict:
    """Return a longer series for charting an indicator.

    ``{indicator, series, points:[{date,value}], latest, as_of, change, pct_change}``.
    ``points`` is the most recent ``max_points`` observations. Raises on failure.
    """
    series_id = _resolve_series(indicator)
    df = _fetch_series(series_id, None, None)
    if df.empty:
        return {"indicator": indicator, "series": series_id, "points": [],
                "latest": None, "as_of": None, "change": None, "pct_change": None}
    df = df.tail(max_points)
    latest = df.iloc[-1]
    prev = df.iloc[-2] if len(df) >= 2 else None
    change = (latest["value"] - prev["value"]) if prev is not None else None
    pct = (change / prev["value"] * 100.0) if (prev is not None and prev["value"]) else None
    return {
        "indicator": indicator,
        "series": series_id,
        "points": [{"date": str(r["date"]), "value": float(r["value"])} for _, r in df.iterrows()],
        "latest": float(latest["value"]),
        "as_of": str(latest["date"]),
        "change": float(change) if change is not None else None,
        "pct_change": float(pct) if pct is not None else None,
    }


def get_economic_indicator(
    indicator: Annotated[str, "alias (e.g. 'unemployment','cpi','10y_treasury') or raw FRED series id"],
    start_date: Annotated[str, "start date yyyy-mm-dd (optional)"] = "",
    end_date: Annotated[str, "end date yyyy-mm-dd (optional)"] = "",
) -> str:
    """Return a macro-economic time series from FRED.

    Accepts a friendly alias or a raw FRED series id. Shows the latest value, the
    prior value, the period change, and a short recent history so the analyst can
    describe both level and trend.
    """
    series_id = _resolve_series(indicator)
    try:
        df = _fetch_series(series_id, start_date or None, end_date or None)
    except Exception as e:
        return f"Error retrieving FRED series '{series_id}' (from '{indicator}'): {e}"

    if df.empty:
        return f"No data returned for indicator '{indicator}' (FRED series '{series_id}')."

    latest = df.iloc[-1]
    prior = df.iloc[-2] if len(df) >= 2 else None
    change_line = ""
    if prior is not None:
        delta = latest["value"] - prior["value"]
        change_line = f"\nChange from prior ({prior['date']}): {delta:+.4g}"

    recent = df.tail(12)
    header = (
        f"# {indicator} — FRED series {series_id}\n"
        f"# Retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
        f"Latest: {latest['value']:.4g} (as of {latest['date']}){change_line}\n\n"
        f"Recent observations:\n"
    )
    return header + recent.to_csv(index=False)


def get_macro_snapshot(
    curr_date: Annotated[str, "as-of date yyyy-mm-dd (for context only)"] = "",
) -> str:
    """One-call snapshot of the key macro basket (rates, inflation, growth, risk).

    Fetches the most market-relevant indicators and reports each one's latest
    value and as-of date in a single table — a fast macro backdrop for the news
    analyst without many separate calls.

    The basket is fetched concurrently under an overall deadline (a single slow
    FRED series no longer stalls the whole table), and the rendered result is
    cached for ``_SNAPSHOT_TTL`` since macro data moves slowly — this is what
    stops the repeated FRED read-timeout warnings on every page load.
    """
    now = time.time()
    with _snapshot_lock:
        hit = _snapshot_cache.get("snapshot")
        if hit and now - hit[0] < _SNAPSHOT_TTL:
            return hit[1]

    def _one(alias: str):
        series_id = _resolve_series(alias)
        try:
            df = _fetch_series(series_id, None, None, timeout=_SNAPSHOT_TIMEOUT)
            if not df.empty:
                latest = df.iloc[-1]
                return (alias, series_id, f"{latest['value']:.4g}", latest["date"])
            return (alias, series_id, "N/A", "")
        except Exception as e:
            # Handled (the row is marked "error" and the table degrades
            # gracefully); a summary is logged once below, so keep this quiet.
            logger.debug("snapshot: %s failed (%s)", alias, e)
            return (alias, series_id, "error", "")

    results: dict[str, tuple] = {}
    with ThreadPoolExecutor(max_workers=min(8, len(_SNAPSHOT))) as ex:
        futures = {ex.submit(_one, alias): alias for alias in _SNAPSHOT}
        try:
            for fut in as_completed(futures, timeout=_SNAPSHOT_DEADLINE):
                row = fut.result()
                results[row[0]] = row
        except FuturesTimeout:
            ex.shutdown(wait=False, cancel_futures=True)
            logger.warning("snapshot: overall deadline hit; %d/%d series returned",
                           len(results), len(_SNAPSHOT))
    # Preserve the basket order; mark any series that didn't make the deadline.
    rows = [results.get(alias, (alias, _resolve_series(alias), "error", "")) for alias in _SNAPSHOT]

    n_bad = sum(1 for r in rows if r[2] in ("error", "N/A"))
    if n_bad:
        logger.warning("macro snapshot: %d/%d FRED series unavailable (cached %dm; "
                       "set FRED_API_KEY for the faster, more reliable JSON API)",
                       n_bad, len(_SNAPSHOT), int(_SNAPSHOT_TTL // 60))

    if not any(r[2] not in ("N/A", "error") for r in rows):
        # Don't cache a total failure — let the next call retry FRED.
        return "Macro snapshot unavailable — could not reach FRED for any series."

    table = pd.DataFrame(rows, columns=["indicator", "fred_series", "latest", "as_of"])
    header = (
        f"# Macro snapshot{f' (as of {curr_date})' if curr_date else ''}\n"
        f"# Source: FRED — Retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    )
    out = header + table.to_csv(index=False)
    with _snapshot_lock:
        _snapshot_cache["snapshot"] = (time.time(), out)
    return out
