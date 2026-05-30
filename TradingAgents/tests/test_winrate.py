"""Tests for the technical win-rate backtest module."""

import pandas as pd
import pytest

from tradingagents.backtest import winrate
from tradingagents.backtest.winrate import (
    SIGNALS,
    SignalSpec,
    compute_signal_winrate,
    format_winrate,
    list_signals,
)


def _ohlcv(closes, start="2025-06-02"):
    """Build a load_ohlcv-shaped frame (business-day dates + OHLCV)."""
    dates = pd.bdate_range(start=start, periods=len(closes))
    return pd.DataFrame({
        "Date": dates,
        "open": closes, "high": closes, "low": closes,
        "close": closes, "volume": [1_000_000] * len(closes),
    })


def test_unknown_signal_raises():
    with pytest.raises(ValueError):
        compute_signal_winrate("AAPL", "not_a_signal", "2026-01-15")


def test_catalog_has_directions():
    rows = list_signals()
    assert rows and all(r["direction"] in ("bullish", "bearish") for r in rows)


def test_winrate_math_with_injected_signal(monkeypatch):
    """Deterministic hit-rate/avg-return for a hand-built series + fake signal."""
    # closes: index 0..5. Signal fires on days 0,1,2. horizon=1 forward return:
    #   day0: 100 -> 110  (+10%)  win
    #   day1: 110 -> 99   (-10%)  loss
    #   day2:  99 -> 108.9(+10%)  win
    closes = [100.0, 110.0, 99.0, 108.9, 108.9, 108.9]
    monkeypatch.setattr(winrate, "load_ohlcv", lambda t, d: _ohlcv(closes))

    fake = SignalSpec(
        "fake_bull", "bullish", "fires on first three days",
        lambda df: pd.Series([True, True, True, False, False, False], index=df.index),
    )
    monkeypatch.setitem(SIGNALS, "fake_bull", fake)
    try:
        r = compute_signal_winrate("AAPL", "fake_bull", "2025-06-20",
                                   horizon_days=1, lookback_years=10)
    finally:
        del SIGNALS["fake_bull"]

    assert r.n_occurrences == 3
    assert r.hit_rate == pytest.approx(2 / 3)
    assert r.avg_forward_return == pytest.approx((0.10 - 0.10 + 0.10) / 3, abs=1e-6)


def test_bearish_signal_wins_on_drops(monkeypatch):
    closes = [100.0, 90.0, 81.0, 81.0]  # day0 -10%, day1 -10%
    monkeypatch.setattr(winrate, "load_ohlcv", lambda t, d: _ohlcv(closes))
    fake = SignalSpec(
        "fake_bear", "bearish", "fires day 0 and 1",
        lambda df: pd.Series([True, True, False, False], index=df.index),
    )
    monkeypatch.setitem(SIGNALS, "fake_bear", fake)
    try:
        r = compute_signal_winrate("X", "fake_bear", "2025-06-20",
                                   horizon_days=1, lookback_years=10)
    finally:
        del SIGNALS["fake_bear"]
    assert r.n_occurrences == 2
    assert r.hit_rate == pytest.approx(1.0)  # both moved down → bearish wins


def test_no_occurrences_returns_empty(monkeypatch):
    closes = [100.0] * 6
    monkeypatch.setattr(winrate, "load_ohlcv", lambda t, d: _ohlcv(closes))
    fake = SignalSpec("never", "bullish", "never fires",
                      lambda df: pd.Series([False] * len(df), index=df.index))
    monkeypatch.setitem(SIGNALS, "never", fake)
    try:
        r = compute_signal_winrate("X", "never", "2025-06-20", horizon_days=1)
    finally:
        del SIGNALS["never"]
    assert r.n_occurrences == 0
    assert r.hit_rate is None
    assert "no occurrences" in format_winrate(r)
