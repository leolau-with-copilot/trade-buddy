"""Structured SQLite store for analysis results, scoreboards, and outcomes.

This is the growing dataset the Judge both writes to (every analysis: its
scoreboard, the signals the researchers cited, the final verdict) and reads from
(past records that feed the feasibility check on the researchers' technical
intuition). It also caches technical win-rate backtests.

It complements — does not replace — the markdown ``TradingMemoryLog``; the
markdown log stays for back-compat while this store provides the queryable,
structured dataset the new pipeline needs.
"""

from .analysis_store import AnalysisStore, default_store_path

__all__ = ["AnalysisStore", "default_store_path"]
