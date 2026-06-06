"""Historical win-rate backtests for named technical signals.

For a ticker and a named signal (e.g. ``rsi_oversold``, ``golden_cross``), this
module finds every historical day the signal fired and measures how often the
price then moved the signal's way over a fixed forward horizon. That hit rate is
the "technical intuition" the bull/bear researchers cite and the Judge verifies.

Design notes
------------
* Price history comes from :func:`tradingagents.dataflows.stockstats_utils.load_ohlcv`,
  which is cached and already filtered to ``<= curr_date`` to prevent look-ahead
  bias — so a backtest "as of" a past date never peeks at future prices.
* Indicators are computed with ``stockstats`` (same library the live indicator
  tools use), so signal definitions stay consistent with what analysts see.
* Each signal has a ``direction``: a *bullish* signal "wins" when the forward
  return is positive; a *bearish* signal "wins" when it is negative. ``hit_rate``
  is therefore "how often the signal's directional bet was right," and
  ``avg_forward_return`` is the signed mean forward return (always raw, so a
  positive number on a bearish signal flags a counter-historical signal).
* This module is pure computation. Caching lives in the SQLite analysis store
  (:mod:`tradingagents.datastore`) so the backtest has no storage dependency.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

import pandas as pd
from stockstats import wrap

from tradingagents.dataflows.stockstats_utils import load_ohlcv

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SignalSpec:
    """Definition of a named technical signal.

    ``detect`` takes a stockstats-wrapped DataFrame and returns a boolean Series
    (indexed like the frame) that is True on days the signal fires.
    """

    name: str
    direction: str  # "bullish" or "bearish"
    description: str
    detect: Callable[[pd.DataFrame], pd.Series]


@dataclass(frozen=True)
class WinRateResult:
    """Outcome of a single signal backtest."""

    ticker: str
    signal: str
    direction: str
    as_of_date: str
    horizon_days: int
    n_occurrences: int
    hit_rate: Optional[float]  # None when no occurrences in window
    avg_forward_return: Optional[float]

    def as_dict(self) -> dict:
        return {
            "ticker": self.ticker,
            "signal": self.signal,
            "direction": self.direction,
            "as_of_date": self.as_of_date,
            "horizon_days": self.horizon_days,
            "n_occurrences": self.n_occurrences,
            "hit_rate": self.hit_rate,
            "avg_forward_return": self.avg_forward_return,
        }


# --- signal detectors --------------------------------------------------------
#
# Each detector returns a boolean Series. "Cross" detectors fire only on the
# transition day (not every day the state holds) so occurrences are roughly
# independent rather than autocorrelated runs.


def _cross_above(fast: pd.Series, slow: pd.Series) -> pd.Series:
    return (fast > slow) & (fast.shift(1) <= slow.shift(1))


def _cross_below(fast: pd.Series, slow: pd.Series) -> pd.Series:
    return (fast < slow) & (fast.shift(1) >= slow.shift(1))


def _enters_below(series: pd.Series, threshold: float) -> pd.Series:
    return (series < threshold) & (series.shift(1) >= threshold)


def _enters_above(series: pd.Series, threshold: float) -> pd.Series:
    return (series > threshold) & (series.shift(1) <= threshold)


SIGNALS: Dict[str, SignalSpec] = {
    "rsi_oversold": SignalSpec(
        "rsi_oversold", "bullish",
        "RSI(14) crosses down through 30 (oversold).",
        lambda df: _enters_below(df["rsi"], 30),
    ),
    "rsi_overbought": SignalSpec(
        "rsi_overbought", "bearish",
        "RSI(14) crosses up through 70 (overbought).",
        lambda df: _enters_above(df["rsi"], 70),
    ),
    "macd_bull_cross": SignalSpec(
        "macd_bull_cross", "bullish",
        "MACD line crosses above its signal line.",
        lambda df: _cross_above(df["macd"], df["macds"]),
    ),
    "macd_bear_cross": SignalSpec(
        "macd_bear_cross", "bearish",
        "MACD line crosses below its signal line.",
        lambda df: _cross_below(df["macd"], df["macds"]),
    ),
    "golden_cross": SignalSpec(
        "golden_cross", "bullish",
        "50-day SMA crosses above the 200-day SMA.",
        lambda df: _cross_above(df["close_50_sma"], df["close_200_sma"]),
    ),
    "death_cross": SignalSpec(
        "death_cross", "bearish",
        "50-day SMA crosses below the 200-day SMA.",
        lambda df: _cross_below(df["close_50_sma"], df["close_200_sma"]),
    ),
    "price_above_sma50": SignalSpec(
        "price_above_sma50", "bullish",
        "Close crosses above the 50-day SMA.",
        lambda df: _cross_above(df["close"], df["close_50_sma"]),
    ),
    "price_below_sma50": SignalSpec(
        "price_below_sma50", "bearish",
        "Close crosses below the 50-day SMA.",
        lambda df: _cross_below(df["close"], df["close_50_sma"]),
    ),
    "price_above_sma200": SignalSpec(
        "price_above_sma200", "bullish",
        "Close crosses above the 200-day SMA.",
        lambda df: _cross_above(df["close"], df["close_200_sma"]),
    ),
    "bollinger_lower_touch": SignalSpec(
        "bollinger_lower_touch", "bullish",
        "Close touches or breaches the lower Bollinger band.",
        lambda df: _enters_below(df["close"], df["boll_lb"]),
    ),
    "bollinger_upper_touch": SignalSpec(
        "bollinger_upper_touch", "bearish",
        "Close touches or breaches the upper Bollinger band.",
        lambda df: _enters_above(df["close"], df["boll_ub"]),
    ),
}


def list_signals() -> List[dict]:
    """Return the signal catalog as ``[{name, direction, description}, ...]``."""
    return [
        {"name": s.name, "direction": s.direction, "description": s.description}
        for s in SIGNALS.values()
    ]


def compute_signal_winrate(
    ticker: str,
    signal: str,
    as_of_date: str,
    horizon_days: int = 5,
    lookback_years: int = 3,
) -> WinRateResult:
    """Backtest ``signal`` on ``ticker`` as of ``as_of_date``.

    Counts occurrences within ``lookback_years`` before ``as_of_date`` whose
    full ``horizon_days`` forward window is available, and reports the fraction
    that moved the signal's way plus the mean signed forward return.

    Raises:
        ValueError: If ``signal`` is not in :data:`SIGNALS`.
    """
    spec = SIGNALS.get(signal)
    if spec is None:
        raise ValueError(
            f"Unknown signal '{signal}'. Known signals: {', '.join(SIGNALS)}"
        )

    data = load_ohlcv(ticker, as_of_date)
    empty = WinRateResult(
        ticker=ticker, signal=signal, direction=spec.direction,
        as_of_date=as_of_date, horizon_days=horizon_days,
        n_occurrences=0, hit_rate=None, avg_forward_return=None,
    )
    if data is None or len(data) < horizon_days + 1:
        return empty

    df = wrap(data.copy())
    # Touch every indicator column the detectors below reference so stockstats
    # materialises them before we slice.
    for col in ("rsi", "macd", "macds", "close_50_sma", "close_200_sma",
                "boll_lb", "boll_ub"):
        try:
            df[col]
        except Exception:  # noqa: BLE001 - missing indicator => skip, detect may not need it
            pass

    close = pd.to_numeric(df["close"], errors="coerce")
    fired = spec.detect(df).fillna(False).to_numpy()

    # Forward return over the horizon; last `horizon_days` rows have no full
    # forward window and are excluded.
    fwd_return = (close.shift(-horizon_days) - close) / close
    dates = pd.to_datetime(df["Date"]) if "Date" in df.columns else pd.to_datetime(df.index)

    cutoff = pd.to_datetime(as_of_date) - pd.DateOffset(years=lookback_years)
    in_window = (dates >= cutoff).to_numpy()
    has_forward = fwd_return.notna().to_numpy()

    mask = fired & in_window & has_forward
    rets = fwd_return.to_numpy()[mask]
    n = int(mask.sum())
    if n == 0:
        return empty

    if spec.direction == "bullish":
        wins = int((rets > 0).sum())
    else:
        wins = int((rets < 0).sum())

    return WinRateResult(
        ticker=ticker, signal=signal, direction=spec.direction,
        as_of_date=as_of_date, horizon_days=horizon_days,
        n_occurrences=n, hit_rate=wins / n, avg_forward_return=float(rets.mean()),
    )


def format_winrate(result: WinRateResult) -> str:
    """Human-/LLM-readable one-paragraph summary of a backtest result."""
    if result.n_occurrences == 0 or result.hit_rate is None:
        return (
            f"{result.signal} ({result.direction}) on {result.ticker}: no "
            f"occurrences in the last {result.as_of_date[:4]}-anchored lookback "
            f"window — no historical win rate available."
        )
    return (
        f"{result.signal} ({result.direction}) on {result.ticker}: fired "
        f"{result.n_occurrences} times; the {result.horizon_days}-day move went "
        f"the signal's way {result.hit_rate:.0%} of the time "
        f"(avg forward return {result.avg_forward_return:+.2%})."
    )
