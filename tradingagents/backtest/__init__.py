"""Backtesting utilities for grounding the researchers' technical intuition.

The bull/bear researchers cite a *historical winning rate* for each technical
signal they lean on; :mod:`tradingagents.backtest.winrate` computes that rate
from real price history so the Judge can verify the claim against a number
rather than vibes.
"""

from .winrate import (
    SIGNALS,
    SignalSpec,
    WinRateResult,
    compute_signal_winrate,
    format_winrate,
    list_signals,
)

__all__ = [
    "SIGNALS",
    "SignalSpec",
    "WinRateResult",
    "compute_signal_winrate",
    "format_winrate",
    "list_signals",
]
