"""The Judge: the pipeline's single, final, scoreboard-driven verdict.

The Judge runs on the tool-capable ``deepseek-chat`` client and:

1. **Verifies** the bull/bear claims against the technical and fundamental
   reports (does the data actually say what they claimed?).
2. **Checks intuition feasibility** by independently backtesting cited signals
   (``get_technical_winrate``), consulting the historical dataset
   (``lookup_signal_history`` / ``lookup_past_analyses``), and ``web_search``.
3. **Weights** each metric and builds a scoreboard, from which the final rating
   follows.
4. **Persists** the analysis, scoreboard, and cited signals to the SQLite store.

Falls back to a free-text judgement + rating heuristic if structured output is
unavailable, so a verdict is always produced.
"""

from __future__ import annotations

import logging
from typing import Dict, Optional, Tuple

from autogen_agentchat.agents import AssistantAgent

from .analysts import strip_raw_tool_calls

from tradingagents.agents.schemas import (
    BearCase,
    BullCase,
    JudgeVerdict,
    PortfolioRating,
    ScoreboardEntry,
    render_judge_verdict,
    weighted_score,
)
from tradingagents.agents.utils.rating import parse_rating
from tradingagents.tools import web_search_tool
from .context import RunContext
from .runtime_tools import make_judge_tools
from .structured import complete_json

logger = logging.getLogger(__name__)

_RATING_GUIDANCE = (
    "Map the weighted score to the rating: > +0.5 Buy; +0.15..+0.5 Overweight; "
    "-0.15..+0.15 Hold; -0.5..-0.15 Underweight; < -0.5 Sell."
)


def _judge_system(ctx: RunContext) -> str:
    return (
        f"You are the Judge — the final decision authority for {ctx.ticker} as of "
        f"{ctx.trade_date}. You receive the bull and bear cases (with the signals "
        f"they cite and the backtested win rates already attached), plus the "
        f"technical and fundamental reports.\n\n"
        f"Your job:\n"
        f"1. VERIFY each side's claims against the technical and fundamental reports — "
        f"call out which hold and which fail.\n"
        f"2. CHECK FEASIBILITY of the cited technical intuition: use get_technical_winrate "
        f"to independently re-backtest signals, lookup_signal_history and "
        f"lookup_past_analyses for this system's track record, and web_search for "
        f"external corroboration.\n"
        f"3. BUILD A SCOREBOARD: for each metric that matters (momentum, trend, "
        f"valuation, growth, sentiment, news, technical intuition, past records), set a "
        f"source, the raw value/finding, a weight (0-1, your judgement of importance), "
        f"and a signed score (-1 bearish to +1 bullish).\n"
        f"4. Set weighted_score to the weight-normalised sum of the scores, then pick a "
        f"rating consistent with it. {_RATING_GUIDANCE}\n"
        f"Be decisive and ground every number in the evidence.{ctx.language_instruction}"
    )


def _judge_task(
    reports: Dict[str, str], bull_md: str, bear_md: str,
    debate_md: str = "", outcome_md: str = "",
) -> str:
    debate_section = ""
    if debate_md:
        debate_section = (
            f"## Bull/Bear debate (multi-round)\n{debate_md}\n\n"
            f"## Debate outcome\n{outcome_md or 'n/a'}\n\n"
            f"If the debate reached a consensus, weigh the agreed sub-points heavily "
            f"but still decide for yourself; if it did not, resolve the remaining "
            f"disagreements yourself. You are the final authority either way.\n\n"
        )
    return (
        f"## Technical / market report\n{reports.get('market_report') or 'n/a'}\n\n"
        f"## Fundamentals report\n{reports.get('fundamentals_report') or 'n/a'}\n\n"
        f"## News report\n{reports.get('news_report') or 'n/a'}\n\n"
        f"## Sentiment report\n{reports.get('sentiment_report') or 'n/a'}\n\n"
        f"## Bull case\n{bull_md}\n\n"
        f"## Bear case\n{bear_md}\n\n"
        f"{debate_section}"
        f"Verify, check feasibility with your tools, then return the final verdict."
    )


def _persist(
    ctx: RunContext, verdict: JudgeVerdict, verdict_md: str,
    bull_case: BullCase, bear_case: BearCase,
) -> int:
    scoreboard = [
        {"metric": e.metric, "source": e.source, "raw_value": e.raw_value,
         "weight": e.weight, "score": e.score, "note": e.note}
        for e in verdict.scoreboard
    ]
    signals = (
        [{"side": "bull", "indicator": s.indicator, "signal": s.signal,
          "claimed_winrate": s.claimed_winrate, "backtest_winrate": s.backtest_winrate,
          "n_occurrences": s.n_occurrences} for s in bull_case.signals]
        + [{"side": "bear", "indicator": s.indicator, "signal": s.signal,
            "claimed_winrate": s.claimed_winrate, "backtest_winrate": s.backtest_winrate,
            "n_occurrences": s.n_occurrences} for s in bear_case.signals]
    )
    return ctx.store.record_analysis(
        ticker=ctx.ticker, trade_date=ctx.trade_date, asset_type=ctx.asset_type,
        final_rating=verdict.rating.value, weighted_score=verdict.weighted_score,
        verdict_md=verdict_md, scoreboard=scoreboard, signals=signals,
    )


async def _verify_with_tools(ctx: RunContext, task: str) -> str:
    """Run the tool-using Judge and return its free-text verification + analysis.

    DeepSeek has no schema/structured-output mode, so the Judge first reasons and
    calls its verification tools here, then a separate JSON pass turns the result
    into a :class:`JudgeVerdict`.
    """
    agent = AssistantAgent(
        name="judge",
        model_client=ctx.chat_client,
        tools=[*make_judge_tools(ctx), web_search_tool],
        system_message=_judge_system(ctx),
        reflect_on_tool_use=True,
        max_tool_iterations=8,
    )
    result = await agent.run(task=task)
    return strip_raw_tool_calls(result.messages[-1].content or "")


async def _to_verdict(ctx: RunContext, analysis: str, task: str) -> JudgeVerdict:
    """Turn the Judge's free-text analysis into a structured JudgeVerdict (JSON)."""
    system = (
        "You are formalising a completed judge analysis into a structured verdict. "
        "Build the scoreboard from the analysis: each metric gets a source, a raw "
        "value/finding, a weight (0-1), and a signed score (-1 bearish to +1 "
        "bullish). Set weighted_score to the weight-normalised sum, and pick a "
        f"rating consistent with it. {_RATING_GUIDANCE}{ctx.language_instruction}"
    )
    user = f"Judge analysis:\n{analysis}\n\nOriginal inputs:\n{task}"
    return await complete_json(ctx.chat_client, system=system, user=user, schema=JudgeVerdict)


def _fallback_verdict(analysis: str) -> JudgeVerdict:
    """Last-resort verdict when JSON formalisation fails: prose + rating heuristic."""
    rating = PortfolioRating(parse_rating(analysis))
    return JudgeVerdict(
        rating=rating, weighted_score=0.0,
        scoreboard=[ScoreboardEntry(
            metric="overall", source="judge", raw_value=rating.value,
            weight=1.0, score=0.0, note="Free-text fallback; scoreboard unavailable.",
        )],
        data_verification="(structured verification unavailable)",
        intuition_feasibility="(structured feasibility check unavailable)",
        verdict_summary=analysis[:1200],
    )


async def run_judge(
    ctx: RunContext,
    reports: Dict[str, str],
    bull_case: BullCase,
    bull_md: str,
    bear_case: BearCase,
    bear_md: str,
    debate_md: str = "",
    outcome_md: str = "",
) -> Tuple[JudgeVerdict, str, int]:
    """Produce, render, and persist the final verdict.

    Returns ``(verdict, verdict_markdown, analysis_id)``.
    """
    task = _judge_task(reports, bull_md, bear_md, debate_md, outcome_md)
    analysis = await _verify_with_tools(ctx, task)
    try:
        verdict = await _to_verdict(ctx, analysis, task)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Judge JSON formalisation failed (%s); using fallback", exc)
        verdict = _fallback_verdict(analysis)

    # Recompute the weighted score from the scoreboard so the stored number and
    # the rating can't silently diverge from the entries.
    if verdict.scoreboard:
        verdict = verdict.model_copy(
            update={"weighted_score": round(weighted_score(verdict.scoreboard), 4)}
        )

    verdict_md = render_judge_verdict(verdict)
    analysis_id = _persist(ctx, verdict, verdict_md, bull_case, bear_case)
    return verdict, verdict_md, analysis_id
