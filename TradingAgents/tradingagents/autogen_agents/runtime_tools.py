"""Run-bound tools and grounding helpers.

Two roles:

* **Deterministic grounding** (``ground_signal_claims``) — the researchers run on
  ``deepseek-reasoner``, which has no reliable function calling, so they cannot
  call the win-rate backtest themselves. Instead they *propose* signal names and
  we backfill the real backtested win rate here. This guarantees the numbers the
  Judge sees are real, not model-guessed.
* **Judge tools** — the Judge runs on ``deepseek-chat`` (tool-capable), so it
  gets live FunctionTools to verify intuition feasibility: the same win-rate
  backtest, the historical signal track record, and recent past analyses.
"""

from __future__ import annotations

import logging
from typing import List

from autogen_core.tools import FunctionTool

from tradingagents.agents.schemas import SignalClaim
from tradingagents.backtest import SIGNALS, compute_signal_winrate
from .context import RunContext

logger = logging.getLogger(__name__)


def compute_winrate_cached(ctx: RunContext, signal: str) -> dict:
    """Backtest ``signal`` for the run's ticker/date, memoised in the store."""
    horizon = ctx.winrate_horizon_days
    lookback = ctx.winrate_lookback_years
    cached = ctx.store.get_cached_winrate(
        ctx.ticker, signal, ctx.trade_date, horizon, lookback
    )
    if cached is not None:
        return {
            "hit_rate": cached["hit_rate"],
            "n_occurrences": cached["n_occurrences"],
            "avg_forward_return": cached["avg_forward_return"],
        }
    result = compute_signal_winrate(
        ctx.ticker, signal, ctx.trade_date,
        horizon_days=horizon, lookback_years=lookback,
    )
    ctx.store.cache_winrate(
        ticker=ctx.ticker, signal=signal, as_of_date=ctx.trade_date,
        horizon_days=horizon, lookback_years=lookback,
        hit_rate=result.hit_rate, n_occurrences=result.n_occurrences,
        avg_forward_return=result.avg_forward_return,
    )
    return {
        "hit_rate": result.hit_rate,
        "n_occurrences": result.n_occurrences,
        "avg_forward_return": result.avg_forward_return,
    }


def ground_signal_claims(
    ctx: RunContext, claims: List[SignalClaim]
) -> List[SignalClaim]:
    """Backfill each claim's ``backtest_winrate``/``n_occurrences`` with real data.

    Unknown signal names are dropped (the researcher hallucinated a signal the
    backtest does not recognise), keeping only verifiable claims.
    """
    grounded: List[SignalClaim] = []
    for claim in claims:
        if claim.signal not in SIGNALS:
            logger.info("Dropping unknown signal claim '%s'", claim.signal)
            continue
        try:
            wr = compute_winrate_cached(ctx, claim.signal)
        except Exception as exc:  # noqa: BLE001 - keep the claim, just ungrounded
            logger.warning("win-rate backtest failed for %s: %s", claim.signal, exc)
            grounded.append(claim)
            continue
        grounded.append(
            claim.model_copy(update={
                "backtest_winrate": wr["hit_rate"],
                "n_occurrences": wr["n_occurrences"],
            })
        )
    return grounded


# --- Judge FunctionTools (bound to the run) ---------------------------------


def make_judge_tools(ctx: RunContext) -> List[FunctionTool]:
    """Build the Judge's verification tools, bound to this run's ticker/date."""

    def get_technical_winrate(signal: str) -> str:
        """Backtest a named technical ``signal`` for the analysed ticker and
        return its historical win rate. Valid signals: see the catalog the
        researchers used (e.g. 'macd_bull_cross', 'rsi_oversold', 'golden_cross').
        """
        if signal not in SIGNALS:
            return (
                f"Unknown signal '{signal}'. Known: {', '.join(SIGNALS)}."
            )
        wr = compute_winrate_cached(ctx, signal)
        if not wr["n_occurrences"]:
            return f"{signal}: no historical occurrences — cannot verify."
        return (
            f"{signal}: fired {wr['n_occurrences']}× historically; "
            f"won {wr['hit_rate']:.0%} of the time "
            f"(avg {ctx.winrate_horizon_days}-day return {wr['avg_forward_return']:+.2%})."
        )

    def lookup_signal_history(signal: str) -> str:
        """Look up the realised track record (in this system's dataset) of past
        analyses that cited ``signal`` — i.e. how often they produced positive
        alpha — as a feasibility cross-check on the live backtest.
        """
        h = ctx.store.signal_history_winrate(signal)
        if not h["n"]:
            return f"No resolved past analyses cited '{signal}' yet."
        return (
            f"'{signal}' cited in {h['n']} resolved analyses; "
            f"{h['win_rate']:.0%} produced positive alpha "
            f"(avg alpha {h['avg_alpha']:+.2%})."
        )

    def lookup_past_analyses() -> str:
        """Return the most recent past analyses for the analysed ticker, with
        their rating and realised outcome where known.
        """
        rows = ctx.store.past_analyses(ctx.ticker, limit=5)
        if not rows:
            return f"No past analyses recorded for {ctx.ticker}."
        lines = [f"Past analyses of {ctx.ticker}:"]
        for r in rows:
            outcome = (
                f"alpha {r['alpha_return']:+.2%}"
                if r.get("alpha_return") is not None else "outcome pending"
            )
            lines.append(
                f"- {r['trade_date']}: {r['final_rating']} ({outcome})"
            )
        return "\n".join(lines)

    return [
        FunctionTool(get_technical_winrate,
                     description="Backtest a technical signal's historical win rate.",
                     name="get_technical_winrate"),
        FunctionTool(lookup_signal_history,
                     description="Realised track record of a signal in past analyses.",
                     name="lookup_signal_history"),
        FunctionTool(lookup_past_analyses,
                     description="Recent past analyses and outcomes for this ticker.",
                     name="lookup_past_analyses"),
    ]
