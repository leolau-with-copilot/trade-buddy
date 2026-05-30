"""Bull and Bear researchers: Tree-of-Thoughts + backtested technical intuition.

Each researcher runs a ToT search on the reasoning model, synthesizes a
structured case (:class:`BullCase` / :class:`BearCase`), and has the win rates of
every cited signal backfilled from a real backtest so the Judge can trust them.
The researchers run on ``deepseek-reasoner`` (no tools), hence the deterministic
post-hoc grounding rather than live tool calls.
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple

from tradingagents.agents.schemas import (
    BearCase,
    BullCase,
    render_bear_case,
    render_bull_case,
)
from tradingagents.backtest import list_signals
from .context import RunContext
from .runtime_tools import ground_signal_claims
from .structured import complete_json
from .tot import tree_of_thoughts


def _signal_catalog_text(direction: str) -> str:
    rows = [s for s in list_signals() if s["direction"] == direction]
    return "\n".join(f"- {s['name']}: {s['description']}" for s in rows)


def _build_context(ctx: RunContext, reports: Dict[str, str], opponent_case: Optional[str]) -> str:
    parts = [
        "Technical/market report:\n" + (reports.get("market_report") or "n/a"),
        "Fundamentals report:\n" + (reports.get("fundamentals_report") or "n/a"),
        "News report:\n" + (reports.get("news_report") or "n/a"),
        "Sentiment report:\n" + (reports.get("sentiment_report") or "n/a"),
    ]
    if ctx.past_context:
        parts.append("Lessons from prior decisions:\n" + ctx.past_context)
    if opponent_case:
        parts.append("Opponent's latest case (rebut its weak points):\n" + opponent_case)
    return "\n\n".join(parts)


async def _synthesize_case(
    ctx: RunContext, schema, side: str, direction: str,
    argument: str, paths_summary: str, context: str,
):
    catalog = _signal_catalog_text(direction)
    system = (
        f"You are the {side} researcher. Produce your final structured {side} case "
        f"from the synthesized argument below. For 'signals', cite only signals from "
        f"this catalog using their EXACT names; give your claimed win rate (0-1) and a "
        f"one-line rationale for each. Set 'tot_summary' from the reasoning-paths note "
        f"and 'conviction' (0-1) honestly.\n\n{direction.capitalize()} signal catalog:\n{catalog}"
        f"{ctx.language_instruction}"
    )
    user = (
        f"Synthesized {side} argument:\n{argument}\n\n"
        f"Reasoning paths: {paths_summary}\n\nContext:\n{context}"
    )
    return await complete_json(ctx.deep_client, system=system, user=user, schema=schema)


async def run_bull(
    ctx: RunContext, reports: Dict[str, str], opponent_case: Optional[str] = None
) -> Tuple[BullCase, str]:
    """Run the bull researcher; returns the BullCase and its rendered markdown."""
    context = _build_context(ctx, reports, opponent_case)
    tot = await tree_of_thoughts(
        ctx.deep_client, side_label="bullish",
        problem=f"Make the strongest case to BUY {ctx.ticker} as of {ctx.trade_date}.",
        context=context,
        breadth=int(ctx.config.get("tot_breadth", 3)),
        depth=int(ctx.config.get("tot_depth", 1)),
        keep=int(ctx.config.get("tot_keep", 2)),
        language_instruction=ctx.language_instruction,
    )
    case = await _synthesize_case(
        ctx, BullCase, "bull", "bullish", tot.argument, tot.paths_summary, context
    )
    case = case.model_copy(update={"signals": ground_signal_claims(ctx, case.signals)})
    return case, render_bull_case(case) + "\n" + tot.render_chain()


async def run_bear(
    ctx: RunContext, reports: Dict[str, str], opponent_case: Optional[str] = None
) -> Tuple[BearCase, str]:
    """Run the bear researcher; returns the BearCase and its rendered markdown."""
    context = _build_context(ctx, reports, opponent_case)
    tot = await tree_of_thoughts(
        ctx.deep_client, side_label="bearish",
        problem=f"Make the strongest case to AVOID or SELL {ctx.ticker} as of {ctx.trade_date}.",
        context=context,
        breadth=int(ctx.config.get("tot_breadth", 3)),
        depth=int(ctx.config.get("tot_depth", 1)),
        keep=int(ctx.config.get("tot_keep", 2)),
        language_instruction=ctx.language_instruction,
    )
    case = await _synthesize_case(
        ctx, BearCase, "bear", "bearish", tot.argument, tot.paths_summary, context
    )
    case = case.model_copy(update={"signals": ground_signal_claims(ctx, case.signals)})
    return case, render_bear_case(case) + "\n" + tot.render_chain()
