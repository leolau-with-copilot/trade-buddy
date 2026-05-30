"""Tests for the SQLite analysis store."""

import pytest

from tradingagents.datastore import AnalysisStore, default_store_path


@pytest.fixture
def store(tmp_path):
    return AnalysisStore(str(tmp_path / "analysis_store.db"))


def _record(store, ticker="NVDA", date="2026-01-15", rating="Buy", score=0.6):
    return store.record_analysis(
        ticker=ticker, trade_date=date, asset_type="stock",
        final_rating=rating, weighted_score=score, verdict_md=f"**Rating**: {rating}",
        scoreboard=[{"metric": "momentum", "source": "technical", "raw_value": 0.8,
                     "weight": 0.5, "score": 0.8, "note": "macd bull"}],
        signals=[{"side": "bull", "indicator": "macd", "signal": "macd_bull_cross",
                  "claimed_winrate": 0.7, "backtest_winrate": 0.65, "n_occurrences": 34}],
    )


def test_default_store_path():
    assert default_store_path("/tmp/cache").endswith("analysis_store.db")


def test_record_and_read_back(store):
    aid = _record(store)
    rows = store.past_analyses("NVDA")
    assert len(rows) == 1
    assert rows[0]["id"] == aid
    assert rows[0]["final_rating"] == "Buy"
    assert rows[0]["alpha_return"] is None  # not resolved yet


def test_pending_then_resolve(store):
    aid = _record(store)
    assert [r["id"] for r in store.pending_outcomes("NVDA")] == [aid]
    store.resolve_outcome(aid, raw_return=0.05, alpha_return=0.02,
                          holding_days=5, benchmark="SPY")
    assert store.pending_outcomes("NVDA") == []
    assert store.past_analyses("NVDA")[0]["alpha_return"] == pytest.approx(0.02)


def test_signal_history_winrate(store):
    # Two analyses citing macd_bull_cross; one positive alpha, one negative.
    a1 = _record(store, date="2026-01-10")
    a2 = _record(store, date="2026-01-11")
    store.resolve_outcome(a1, raw_return=0.05, alpha_return=0.03, holding_days=5, benchmark="SPY")
    store.resolve_outcome(a2, raw_return=-0.02, alpha_return=-0.01, holding_days=5, benchmark="SPY")
    h = store.signal_history_winrate("macd_bull_cross")
    assert h["n"] == 2
    assert h["win_rate"] == pytest.approx(0.5)
    assert h["avg_alpha"] == pytest.approx(0.01)
    assert h["avg_backtest_winrate"] == pytest.approx(0.65)


def test_signal_history_empty(store):
    h = store.signal_history_winrate("golden_cross")
    assert h["n"] == 0 and h["win_rate"] is None


def test_winrate_cache_roundtrip(store):
    assert store.get_cached_winrate("NVDA", "macd_bull_cross", "2026-01-15", 5, 3) is None
    store.cache_winrate(ticker="NVDA", signal="macd_bull_cross", as_of_date="2026-01-15",
                        horizon_days=5, lookback_years=3, hit_rate=0.65,
                        n_occurrences=34, avg_forward_return=0.015)
    cached = store.get_cached_winrate("NVDA", "macd_bull_cross", "2026-01-15", 5, 3)
    assert cached["hit_rate"] == pytest.approx(0.65)
    assert cached["n_occurrences"] == 34
