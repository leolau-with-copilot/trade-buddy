"""Async orchestrator that wires the AutoGen pipeline.

Replaces the LangGraph ``StateGraph`` (old ``graph/setup.py`` +
``conditional_logic.py``). The flow is deterministic and hand-written rather than
graph-compiled, because the topology is now linear:

    analysts → bull/bear ToT debate (N rounds) → Judge verdict

An optional ``on_event(stage, status)`` callback lets the CLI drive its live
status panel without coupling the orchestrator to any UI.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from tradingagents.agents.schemas import (
    BearCase, BullCase, JudgeVerdict, render_debate_outcome,
)
from tradingagents.autogen_agents import (
    RunContext,
    run_analyst,
    run_bear,
    run_bull,
    run_debate,
    run_judge,
)
from tradingagents.autogen_agents.analysts import DISPLAY_NAME, REPORT_FIELD

logger = logging.getLogger(__name__)

# on_event(stage, status, content, meta) — content is the finished section's
# markdown on "completed"; meta carries extra payload for debate/consensus/usage
# pseudo-events. Older 3-arg callbacks are still supported (see ``_emit``).
EventCb = Optional[Callable[..., None]]


@dataclass
class AnalysisResult:
    """Everything one analysis run produces, in a flat shape for logging/CLI."""

    company_of_interest: str
    trade_date: str
    asset_type: str
    market_report: str = ""
    fundamentals_report: str = ""
    news_report: str = ""
    sentiment_report: str = ""
    smart_money_report: str = ""
    macro_report: str = ""
    bull_case: Optional[BullCase] = None
    bull_case_md: str = ""
    bear_case: Optional[BearCase] = None
    bear_case_md: str = ""
    verdict: Optional[JudgeVerdict] = None
    judge_verdict_md: str = ""
    debate_md: str = ""
    consensus_reached: Optional[bool] = None
    final_trade_decision: str = ""
    weighted_score: Optional[float] = None
    rating: Optional[str] = None
    analysis_id: Optional[int] = None
    scoreboard: List[dict] = field(default_factory=list)

    def to_state_dict(self) -> Dict[str, Any]:
        """Flat dict for disk logs and CLI rendering."""
        return {
            "company_of_interest": self.company_of_interest,
            "trade_date": self.trade_date,
            "asset_type": self.asset_type,
            "market_report": self.market_report,
            "fundamentals_report": self.fundamentals_report,
            "news_report": self.news_report,
            "sentiment_report": self.sentiment_report,
            "smart_money_report": self.smart_money_report,
            "macro_report": self.macro_report,
            "bull_case_md": self.bull_case_md,
            "bear_case_md": self.bear_case_md,
            "debate_md": self.debate_md,
            "consensus_reached": self.consensus_reached,
            "scoreboard": self.scoreboard,
            "judge_verdict_md": self.judge_verdict_md,
            "weighted_score": self.weighted_score,
            "rating": self.rating,
            "final_trade_decision": self.final_trade_decision,
            "analysis_id": self.analysis_id,
        }


def _emit(
    cb: EventCb, stage: str, status: str,
    content: Optional[str] = None, meta: Optional[dict] = None,
) -> None:
    if cb is None:
        return
    try:
        cb(stage, status, content, meta)
    except TypeError:
        # Back-compat with 3-arg callbacks that predate the meta channel.
        try:
            cb(stage, status, content)
        except Exception:  # noqa: BLE001
            logger.debug("on_event callback raised", exc_info=True)
    except Exception:  # noqa: BLE001 - UI callback must never break the run
        logger.debug("on_event callback raised", exc_info=True)


def _token_usage(ctx: RunContext) -> tuple[int, int]:
    """Cumulative (prompt, completion) tokens across both model clients."""
    ti = to = 0
    for client in (ctx.chat_client, ctx.deep_client):
        try:
            usage = client.total_usage()
            ti += int(getattr(usage, "prompt_tokens", 0) or 0)
            to += int(getattr(usage, "completion_tokens", 0) or 0)
        except Exception:  # noqa: BLE001 - fake clients / unsupported providers
            pass
    return ti, to


def _emit_usage(cb: EventCb, ctx: RunContext) -> None:
    # Always emit (even zeros) so the tracker refreshes the moment any new text
    # is produced, rather than only when a stage happens to have nonzero usage.
    # NOTE: status must be "usage" — both the CLI and web consumers branch on it.
    ti, to = _token_usage(ctx)
    _emit(cb, "usage", "usage", None, {"tokens_in": ti, "tokens_out": to})


async def run_analysis(
    ctx: RunContext,
    selected_analysts: List[str],
    *,
    on_event: EventCb = None,
) -> AnalysisResult:
    """Run the full pipeline for one ticker/date and return the result."""
    result = AnalysisResult(
        company_of_interest=ctx.ticker,
        trade_date=ctx.trade_date,
        asset_type=ctx.asset_type,
    )

    # 1. Analysts. Sequential by default; concurrent if configured.
    reports: Dict[str, str] = {}
    concurrency = int(ctx.config.get("analyst_concurrency_limit", 1))

    async def _one(key: str) -> None:
        _emit(on_event, DISPLAY_NAME[key], "in_progress")
        report = await run_analyst(key, ctx)
        reports[REPORT_FIELD[key]] = report
        setattr(result, REPORT_FIELD[key], report)
        _emit(on_event, DISPLAY_NAME[key], "completed", report)
        _emit_usage(on_event, ctx)

    if concurrency > 1:
        sem = asyncio.Semaphore(concurrency)

        async def _guarded(key: str) -> None:
            async with sem:
                await _one(key)

        await asyncio.gather(*(_guarded(k) for k in selected_analysts))
    else:
        for key in selected_analysts:
            await _one(key)

    # 2. Bull and Bear each present their Tree-of-Thoughts case.
    _emit(on_event, "Bull Researcher", "in_progress")
    bull_case, bull_md = await run_bull(ctx, reports)
    _emit(on_event, "Bull Researcher", "completed", bull_md)
    _emit_usage(on_event, ctx)

    _emit(on_event, "Bear Researcher", "in_progress")
    bear_case, bear_md = await run_bear(ctx, reports, opponent_case=bull_md)
    _emit(on_event, "Bear Researcher", "completed", bear_md)
    _emit_usage(on_event, ctx)

    result.bull_case, result.bull_case_md = bull_case, bull_md
    result.bear_case, result.bear_case_md = bear_case, bear_md

    # 2b. Live debate: ≥3 rounds, alternating counter-arguments + concessions,
    # each side self-correcting before it speaks, then a consensus check.
    rounds = max(3, int(ctx.config.get("max_debate_rounds", 3)))

    def _on_turn(side: str, rnd: int, summary: str, md: str) -> None:
        stage = "Bull Researcher" if side == "bull" else "Bear Researcher"
        _emit(on_event, stage, "debate", md,
              {"side": side, "round": rnd, "rounds": rounds, "summary": summary})
        _emit_usage(on_event, ctx)  # refresh tokens as each turn streams in

    # Both researchers are "active" through the debate.
    _emit(on_event, "Bull Researcher", "in_progress")
    _emit(on_event, "Bear Researcher", "in_progress")
    debate_md, outcome, _turns = await run_debate(
        ctx, reports, bull_md, bear_md, rounds=rounds, on_turn=_on_turn
    )
    outcome_md = render_debate_outcome(outcome)
    _emit(on_event, "Debate", "consensus", outcome_md,
          {"consensus_reached": outcome.consensus_reached,
           "consensus_summary": outcome.consensus_summary,
           "sub_points": outcome.sub_points,
           "remaining_disagreements": outcome.remaining_disagreements})
    _emit(on_event, "Bull Researcher", "completed")
    _emit(on_event, "Bear Researcher", "completed")
    _emit_usage(on_event, ctx)

    result.debate_md = f"{debate_md}\n\n{outcome_md}".strip()
    result.consensus_reached = outcome.consensus_reached

    # 3. Judge — the only verdict, informed by the debate and its outcome.
    _emit(on_event, "Judge", "in_progress")
    verdict, verdict_md, analysis_id = await run_judge(
        ctx, reports, bull_case, bull_md, bear_case, bear_md,
        debate_md=debate_md, outcome_md=outcome_md,
    )
    _emit(on_event, "Judge", "completed", verdict_md)
    _emit_usage(on_event, ctx)

    result.verdict = verdict
    result.judge_verdict_md = verdict_md
    result.final_trade_decision = verdict_md
    result.weighted_score = verdict.weighted_score
    result.rating = verdict.rating.value
    result.analysis_id = analysis_id
    result.scoreboard = [
        {"metric": e.metric, "source": e.source, "raw_value": e.raw_value,
         "weight": e.weight, "score": e.score, "note": e.note}
        for e in verdict.scoreboard
    ]
    return result
