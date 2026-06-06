"""AKShare vendor for China A-share / index OHLCV data.

yfinance is unreliable for mainland-China listings (gaps, stale bars, suffix
quirks). AKShare scrapes Eastmoney's public endpoints and returns clean daily
bars for Shanghai/Shenzhen-listed equities with no API token required.

This module mirrors the shape of :mod:`y_finance` so it slots into the existing
``route_to_vendor`` layer:

* :func:`load_ohlcv_akshare` returns the same ``Date/Open/High/Low/Close/Volume``
  DataFrame that :func:`stockstats_utils.load_ohlcv` does, so ``stockstats`` and
  the indicator window work unchanged.
* :func:`get_akshare_data_online` returns a CSV string like
  :func:`y_finance.get_YFin_data_online`.
* :func:`get_stock_stats_indicators_window_akshare` reuses the yfinance indicator
  catalog, only swapping the OHLCV loader.

Ticker forms accepted: ``600519`` / ``600519.SH`` / ``600519.SS`` / ``000001.SZ``.
The exchange suffix is stripped to the bare 6-digit code AKShare expects; the
suffix is otherwise informational (AKShare infers the board from the code).
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import Annotated

import pandas as pd

from .config import get_config
from .stockstats_utils import _clean_dataframe
from .utils import safe_ticker_component

logger = logging.getLogger(__name__)

# AKShare daily bars come back with Chinese column headers. Map every known
# header to our canonical English name; anything unmapped is dropped later.
_CN_COL_MAP = {
    "日期": "Date",
    "股票代码": "Code",
    "开盘": "Open",
    "收盘": "Close",
    "最高": "High",
    "最低": "Low",
    "成交量": "Volume",
    "成交额": "Amount",
    "振幅": "Amplitude",
    "涨跌幅": "PctChg",
    "涨跌额": "Change",
    "换手率": "Turnover",
}

# 6-digit A-share codes, optionally suffixed with an exchange tag.
_CHINA_SUFFIXES = (".SH", ".SS", ".SZ", ".SHG", ".SHE")
_BARE_CODE_RE = re.compile(r"^\d{6}$")


def is_china_a_share(symbol: str) -> bool:
    """True when ``symbol`` looks like a mainland-China A-share listing.

    Matches an explicit Shanghai/Shenzhen suffix (``600519.SH``) or a bare
    6-digit code on a recognised board (``600519``, ``000001``, ``300750``,
    ``688981``). Hong Kong (``.HK``) and US tickers are intentionally excluded —
    yfinance handles those well.
    """
    if not symbol:
        return False
    s = symbol.strip().upper()
    if s.endswith(_CHINA_SUFFIXES):
        return True
    if _BARE_CODE_RE.match(s):
        # Boards: 60/68 = Shanghai, 00/30 = Shenzhen, 8/4 = Beijing.
        return s[:2] in {"60", "68", "00", "30", "83", "43", "87"} or s[0] in {"4", "8"}
    return False


def to_akshare_code(symbol: str) -> str:
    """Strip any exchange suffix down to the bare 6-digit AKShare code."""
    s = symbol.strip().upper()
    if "." in s:
        s = s.split(".")[0]
    if not _BARE_CODE_RE.match(s):
        raise ValueError(f"not a China A-share code: {symbol!r}")
    return s


def _normalize_akshare_df(raw: pd.DataFrame) -> pd.DataFrame:
    """Rename AKShare's columns to canonical OHLCV and keep the price fields.

    Falls back to positional mapping if the headers aren't the expected Chinese
    names (older/newer AKShare releases occasionally differ), since the column
    *order* — date, open, close, high, low, volume, … — is stable.
    """
    df = raw.copy()
    if any(c in _CN_COL_MAP for c in df.columns):
        df = df.rename(columns={c: _CN_COL_MAP[c] for c in df.columns if c in _CN_COL_MAP})
    else:
        # Positional fallback: date, open, close, high, low, volume[, amount, …]
        positional = ["Date", "Open", "Close", "High", "Low", "Volume"]
        rename = {df.columns[i]: positional[i] for i in range(min(len(positional), len(df.columns)))}
        df = df.rename(columns=rename)

    keep = [c for c in ["Date", "Open", "High", "Low", "Close", "Volume"] if c in df.columns]
    return df[keep]


def _fetch_akshare_hist(code: str, start: str, end: str, adjust: str = "qfq") -> pd.DataFrame:
    """Call AKShare for daily bars. Dates are ``YYYYMMDD`` per the AKShare API."""
    import akshare as ak

    raw = ak.stock_zh_a_hist(
        symbol=code,
        period="daily",
        start_date=start.replace("-", ""),
        end_date=end.replace("-", ""),
        adjust=adjust,
    )
    # Be polite to the public endpoint when called in a loop elsewhere.
    time.sleep(0.2)
    return _normalize_akshare_df(raw)


def load_ohlcv_akshare(symbol: str, curr_date: str) -> pd.DataFrame:
    """China-market analogue of :func:`stockstats_utils.load_ohlcv`.

    Downloads ~5 years of forward-adjusted (``qfq``) daily bars up to today,
    caches per symbol/day, then filters to ``curr_date`` to avoid look-ahead.
    Returns the canonical ``Date/Open/High/Low/Close/Volume`` frame so the
    shared ``stockstats`` indicator path works without changes.
    """
    safe_symbol = safe_ticker_component(symbol)
    code = to_akshare_code(symbol)
    config = get_config()
    curr_date_dt = pd.to_datetime(curr_date)

    today = pd.Timestamp.today().normalize()
    start_str = (today - pd.DateOffset(years=5)).strftime("%Y-%m-%d")
    today_str = today.strftime("%Y-%m-%d")

    os.makedirs(config["data_cache_dir"], exist_ok=True)
    data_file = os.path.join(
        config["data_cache_dir"],
        f"{safe_symbol}-AKShare-data-{start_str}-{today_str}.csv",
    )

    if os.path.exists(data_file):
        data = pd.read_csv(data_file, on_bad_lines="skip", encoding="utf-8")
    else:
        data = _fetch_akshare_hist(code, start_str, today_str)
        data.to_csv(data_file, index=False, encoding="utf-8")

    data = _clean_dataframe(data)
    data = data[data["Date"] <= curr_date_dt]
    return data


def get_akshare_data_online(
    symbol: Annotated[str, "China A-share ticker, e.g. 600519 or 600519.SH"],
    start_date: Annotated[str, "Start date yyyy-mm-dd"],
    end_date: Annotated[str, "End date yyyy-mm-dd"],
) -> str:
    """Return a CSV string of China A-share OHLCV bars between two dates."""
    code = to_akshare_code(symbol)
    try:
        data = _fetch_akshare_hist(code, start_date, end_date)
    except Exception as e:  # network/parse failure — report, don't crash the run
        return f"Error retrieving AKShare data for '{symbol}': {e}"

    if data.empty:
        return f"No data found for symbol '{symbol}' between {start_date} and {end_date}"

    data = _clean_dataframe(data)
    for col in ["Open", "High", "Low", "Close"]:
        if col in data.columns:
            data[col] = data[col].round(2)

    from datetime import datetime as _dt

    header = (
        f"# Stock data for {symbol.upper()} (AKShare) from {start_date} to {end_date}\n"
        f"# Total records: {len(data)}\n"
        f"# Data retrieved on: {_dt.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    )
    return header + data.to_csv(index=False)


def get_stock_stats_indicators_window_akshare(
    symbol: Annotated[str, "China A-share ticker"],
    indicator: Annotated[str, "technical indicator"],
    curr_date: Annotated[str, "current trading date yyyy-mm-dd"],
    look_back_days: Annotated[int, "how many days to look back"],
) -> str:
    """China-market indicator window: reuse the yfinance catalog + AKShare OHLCV."""
    from .y_finance import get_stock_stats_indicators_window

    return get_stock_stats_indicators_window(
        symbol, indicator, curr_date, look_back_days, loader=load_ohlcv_akshare
    )
