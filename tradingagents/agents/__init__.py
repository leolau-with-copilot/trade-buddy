"""Agent-side shared types.

The concrete agents now live in :mod:`tradingagents.autogen_agents` (AutoGen 0.4).
This package retains only the cross-cutting building blocks that survived the
migration: the Pydantic output schemas and the prompt/rating utilities under
``utils``.
"""

from .schemas import (
    BearCase,
    BullCase,
    JudgeVerdict,
    PortfolioRating,
    ScoreboardEntry,
    SignalClaim,
    render_bear_case,
    render_bull_case,
    render_judge_verdict,
    weighted_score,
)

__all__ = [
    "PortfolioRating",
    "SignalClaim",
    "BullCase",
    "BearCase",
    "ScoreboardEntry",
    "JudgeVerdict",
    "render_bull_case",
    "render_bear_case",
    "render_judge_verdict",
    "weighted_score",
]
