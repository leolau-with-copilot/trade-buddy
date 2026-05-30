"""Pydantic schemas used by agents that produce structured output.

The framework's primary artifact is still prose: each agent's natural-language
reasoning is what users read in the saved markdown reports and what the
downstream agents read as context.  Structured output is layered onto the
three decision-making agents (Research Manager, Trader, Portfolio Manager)
so that:

- Their outputs follow consistent section headers across runs and providers
- Each provider's native structured-output mode is used (json_schema for
  OpenAI/xAI, response_schema for Gemini, tool-use for Anthropic)
- Schema field descriptions become the model's output instructions, freeing
  the prompt body to focus on context and the rating-scale guidance
- A render helper turns the parsed Pydantic instance back into the same
  markdown shape the rest of the system already consumes, so display,
  memory log, and saved reports keep working unchanged
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Shared rating types
# ---------------------------------------------------------------------------


class PortfolioRating(str, Enum):
    """5-tier rating used by the Research Manager and Portfolio Manager."""

    BUY = "Buy"
    OVERWEIGHT = "Overweight"
    HOLD = "Hold"
    UNDERWEIGHT = "Underweight"
    SELL = "Sell"


class TraderAction(str, Enum):
    """3-tier transaction direction used by the Trader.

    The Trader's job is to translate the Research Manager's investment plan
    into a concrete transaction proposal: should the desk execute a Buy, a
    Sell, or sit on Hold this round.  Position sizing and the nuanced
    Overweight / Underweight calls happen later at the Portfolio Manager.
    """

    BUY = "Buy"
    HOLD = "Hold"
    SELL = "Sell"


# ---------------------------------------------------------------------------
# Research Manager
# ---------------------------------------------------------------------------


class ResearchPlan(BaseModel):
    """Structured investment plan produced by the Research Manager.

    Hand-off to the Trader: the recommendation pins the directional view,
    the rationale captures which side of the bull/bear debate carried the
    argument, and the strategic actions translate that into concrete
    instructions the trader can execute against.
    """

    recommendation: PortfolioRating = Field(
        description=(
            "The investment recommendation. Exactly one of Buy / Overweight / "
            "Hold / Underweight / Sell. Reserve Hold for situations where the "
            "evidence on both sides is genuinely balanced; otherwise commit to "
            "the side with the stronger arguments."
        ),
    )
    rationale: str = Field(
        description=(
            "Conversational summary of the key points from both sides of the "
            "debate, ending with which arguments led to the recommendation. "
            "Speak naturally, as if to a teammate."
        ),
    )
    strategic_actions: str = Field(
        description=(
            "Concrete steps for the trader to implement the recommendation, "
            "including position sizing guidance consistent with the rating."
        ),
    )


def render_research_plan(plan: ResearchPlan) -> str:
    """Render a ResearchPlan to markdown for storage and the trader's prompt context."""
    return "\n".join([
        f"**Recommendation**: {plan.recommendation.value}",
        "",
        f"**Rationale**: {plan.rationale}",
        "",
        f"**Strategic Actions**: {plan.strategic_actions}",
    ])


# ---------------------------------------------------------------------------
# Trader
# ---------------------------------------------------------------------------


class TraderProposal(BaseModel):
    """Structured transaction proposal produced by the Trader.

    The trader reads the Research Manager's investment plan and the analyst
    reports, then turns them into a concrete transaction: what action to
    take, the reasoning that justifies it, and the practical levels for
    entry, stop-loss, and sizing.
    """

    action: TraderAction = Field(
        description="The transaction direction. Exactly one of Buy / Hold / Sell.",
    )
    reasoning: str = Field(
        description=(
            "The case for this action, anchored in the analysts' reports and "
            "the research plan. Two to four sentences."
        ),
    )
    entry_price: Optional[float] = Field(
        default=None,
        description="Optional entry price target in the instrument's quote currency.",
    )
    stop_loss: Optional[float] = Field(
        default=None,
        description="Optional stop-loss price in the instrument's quote currency.",
    )
    position_sizing: Optional[str] = Field(
        default=None,
        description="Optional sizing guidance, e.g. '5% of portfolio'.",
    )


def render_trader_proposal(proposal: TraderProposal) -> str:
    """Render a TraderProposal to markdown.

    The trailing ``FINAL TRANSACTION PROPOSAL: **BUY/HOLD/SELL**`` line is
    preserved for backward compatibility with the analyst stop-signal text
    and any external code that greps for it.
    """
    parts = [
        f"**Action**: {proposal.action.value}",
        "",
        f"**Reasoning**: {proposal.reasoning}",
    ]
    if proposal.entry_price is not None:
        parts.extend(["", f"**Entry Price**: {proposal.entry_price}"])
    if proposal.stop_loss is not None:
        parts.extend(["", f"**Stop Loss**: {proposal.stop_loss}"])
    if proposal.position_sizing:
        parts.extend(["", f"**Position Sizing**: {proposal.position_sizing}"])
    parts.extend([
        "",
        f"FINAL TRANSACTION PROPOSAL: **{proposal.action.value.upper()}**",
    ])
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Portfolio Manager
# ---------------------------------------------------------------------------


class PortfolioDecision(BaseModel):
    """Structured output produced by the Portfolio Manager.

    The model fills every field as part of its primary LLM call; no separate
    extraction pass is required. Field descriptions double as the model's
    output instructions, so the prompt body only needs to convey context and
    the rating-scale guidance.
    """

    rating: PortfolioRating = Field(
        description=(
            "The final position rating. Exactly one of Buy / Overweight / Hold / "
            "Underweight / Sell, picked based on the analysts' debate."
        ),
    )
    executive_summary: str = Field(
        description=(
            "A concise action plan covering entry strategy, position sizing, "
            "key risk levels, and time horizon. Two to four sentences."
        ),
    )
    investment_thesis: str = Field(
        description=(
            "Detailed reasoning anchored in specific evidence from the analysts' "
            "debate. If prior lessons are referenced in the prompt context, "
            "incorporate them; otherwise rely solely on the current analysis."
        ),
    )
    price_target: Optional[float] = Field(
        default=None,
        description="Optional target price in the instrument's quote currency.",
    )
    time_horizon: Optional[str] = Field(
        default=None,
        description="Optional recommended holding period, e.g. '3-6 months'.",
    )


def render_pm_decision(decision: PortfolioDecision) -> str:
    """Render a PortfolioDecision back to the markdown shape the rest of the system expects.

    Memory log, CLI display, and saved report files all read this markdown,
    so the rendered output preserves the exact section headers (``**Rating**``,
    ``**Executive Summary**``, ``**Investment Thesis**``) that downstream
    parsers and the report writers already handle.
    """
    parts = [
        f"**Rating**: {decision.rating.value}",
        "",
        f"**Executive Summary**: {decision.executive_summary}",
        "",
        f"**Investment Thesis**: {decision.investment_thesis}",
    ]
    if decision.price_target is not None:
        parts.extend(["", f"**Price Target**: {decision.price_target}"])
    if decision.time_horizon:
        parts.extend(["", f"**Time Horizon**: {decision.time_horizon}"])
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Tree-of-Thoughts researchers (Bull / Bear)
# ---------------------------------------------------------------------------


class SignalClaim(BaseModel):
    """A technical-intuition claim a researcher leans on.

    Each claim names a backtestable signal (see
    :data:`tradingagents.backtest.winrate.SIGNALS`) so the Judge can verify the
    cited win rate against a real backtest and the historical dataset, rather
    than taking the researcher's word for it.
    """

    indicator: str = Field(description="The indicator family, e.g. 'macd', 'rsi', 'sma'.")
    signal: str = Field(
        description=(
            "The exact backtestable signal name, e.g. 'macd_bull_cross', "
            "'rsi_oversold', 'golden_cross'. Must be one the win-rate tool knows."
        ),
    )
    claimed_winrate: float = Field(
        description="The historical win rate (0-1) you believe this signal carries.",
    )
    backtest_winrate: Optional[float] = Field(
        default=None,
        description="The win rate the backtest tool returned (0-1), if you called it.",
    )
    n_occurrences: Optional[int] = Field(
        default=None,
        description="How many times the signal fired historically, per the backtest.",
    )
    rationale: str = Field(
        description="One sentence on why this signal supports your side right now.",
    )


class BullCase(BaseModel):
    """The Bull researcher's structured case, distilled from a Tree-of-Thoughts search."""

    thesis: str = Field(description="The core bullish thesis in 2-3 sentences.")
    key_points: list[str] = Field(
        description="The strongest bullish arguments, best first.",
    )
    signals: list[SignalClaim] = Field(
        default_factory=list,
        description="Backtested technical signals supporting the bull case.",
    )
    tot_summary: str = Field(
        description=(
            "A short note on the reasoning paths explored and why the winning "
            "line of argument was chosen over the alternatives."
        ),
    )
    conviction: float = Field(
        description="Your conviction in the bull case, 0 (weak) to 1 (strong).",
    )


class BearCase(BaseModel):
    """The Bear researcher's structured case, distilled from a Tree-of-Thoughts search."""

    thesis: str = Field(description="The core bearish thesis in 2-3 sentences.")
    key_points: list[str] = Field(
        description="The strongest bearish arguments, best first.",
    )
    signals: list[SignalClaim] = Field(
        default_factory=list,
        description="Backtested technical signals supporting the bear case.",
    )
    tot_summary: str = Field(
        description=(
            "A short note on the reasoning paths explored and why the winning "
            "line of argument was chosen over the alternatives."
        ),
    )
    conviction: float = Field(
        description="Your conviction in the bear case, 0 (weak) to 1 (strong).",
    )


def _render_signals(signals: list[SignalClaim]) -> list[str]:
    if not signals:
        return []
    lines = ["", "**Cited signals**:"]
    for s in signals:
        bt = (
            f", backtest {s.backtest_winrate:.0%}"
            f"{f' over {s.n_occurrences}×' if s.n_occurrences else ''}"
            if s.backtest_winrate is not None else ""
        )
        lines.append(
            f"- `{s.signal}` (claimed {s.claimed_winrate:.0%}{bt}): {s.rationale}"
        )
    return lines


def render_bull_case(case: BullCase) -> str:
    """Render a BullCase to markdown for the Judge's context and saved reports."""
    parts = [
        f"**Bull Thesis** (conviction {case.conviction:.0%}): {case.thesis}",
        "",
        "**Key points**:",
        *[f"- {p}" for p in case.key_points],
    ]
    parts += _render_signals(case.signals)
    parts += ["", f"**Reasoning paths**: {case.tot_summary}"]
    return "\n".join(parts)


def render_bear_case(case: BearCase) -> str:
    """Render a BearCase to markdown for the Judge's context and saved reports."""
    parts = [
        f"**Bear Thesis** (conviction {case.conviction:.0%}): {case.thesis}",
        "",
        "**Key points**:",
        *[f"- {p}" for p in case.key_points],
    ]
    parts += _render_signals(case.signals)
    parts += ["", f"**Reasoning paths**: {case.tot_summary}"]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Live bull vs. bear debate (multi-round)
# ---------------------------------------------------------------------------


class DebateSpeech(BaseModel):
    """One researcher's turn in the live debate.

    Before arguing, the speaker self-corrects any mistakes in its earlier
    statements, then concedes the opponent's valid points and presses sharp
    counter-arguments — all grounded in the shared evidence.
    """

    self_correction: str = Field(
        description=(
            "Corrections to mistakes in YOUR earlier statements this debate. "
            "Write 'No correction needed.' if you stand by everything so far."
        ),
    )
    concessions: list[str] = Field(
        description="Points from the opponent's latest case you concede are valid.",
    )
    counters: list[str] = Field(
        description="Counter-arguments exposing weaknesses in the opponent's case.",
    )
    summary: str = Field(
        description="A 6-10 word headline of your main move this round.",
    )


def render_debate_speech(side: str, round_no: int, sp: DebateSpeech) -> str:
    """Render one debate turn to markdown."""
    parts = [f"**{side} — round {round_no}**", ""]
    sc = (sp.self_correction or "").strip()
    if sc and sc.lower() not in ("none", "no correction needed.", "n/a"):
        parts += [f"*Self-correction*: {sc}", ""]
    if sp.concessions:
        parts += ["*Concedes*:", *[f"- {c}" for c in sp.concessions], ""]
    if sp.counters:
        parts += ["*Counters*:", *[f"- {c}" for c in sp.counters]]
    return "\n".join(parts).rstrip()


class DebateOutcome(BaseModel):
    """Whether the debate reached a compromise, decided by a neutral moderator."""

    consensus_reached: bool = Field(
        description="True if the bull and bear positions can be compromised into one view.",
    )
    consensus_summary: str = Field(
        description="If consensus, the shared view both sides accept; else ''.",
    )
    sub_points: list[str] = Field(
        default_factory=list,
        description="If consensus, the agreed sub-points handed to the Judge.",
    )
    remaining_disagreements: list[str] = Field(
        default_factory=list,
        description="If no consensus, the unresolved points left for the Judge.",
    )


def render_debate_outcome(o: DebateOutcome) -> str:
    """Render the debate's consensus result to markdown."""
    if o.consensus_reached:
        parts = ["**Debate outcome — consensus reached** ✓", ""]
        if o.consensus_summary:
            parts += [o.consensus_summary, ""]
        if o.sub_points:
            parts += ["**Agreed sub-points (to the Judge):**", *[f"- {p}" for p in o.sub_points]]
    else:
        parts = ["**Debate outcome — no consensus; the Judge decides** ⚖️", ""]
        if o.remaining_disagreements:
            parts += ["**Unresolved disagreements:**",
                      *[f"- {d}" for d in o.remaining_disagreements]]
    return "\n".join(parts).rstrip()


# ---------------------------------------------------------------------------
# Judge (final authority)
# ---------------------------------------------------------------------------


class ScoreboardEntry(BaseModel):
    """One weighted metric on the Judge's scoreboard.

    ``score`` is the metric's signed contribution from -1 (maximally bearish) to
    +1 (maximally bullish); ``weight`` (0-1) is how important the Judge deems
    that metric. The final verdict is driven by the weighted sum of these.
    """

    metric: str = Field(description="Metric name, e.g. 'momentum', 'valuation', 'sentiment'.")
    source: str = Field(
        description=(
            "Where the evidence came from: 'technical', 'fundamental', 'news', "
            "'sentiment', 'intuition' (backtested win rate), or 'past_records'."
        ),
    )
    raw_value: str = Field(description="The underlying figure or finding, as a short string.")
    weight: float = Field(description="Importance of this metric, 0-1.")
    score: float = Field(description="Signed bullish/bearish score for this metric, -1 to +1.")
    note: str = Field(description="One line justifying the score and how it was verified.")


class JudgeVerdict(BaseModel):
    """The Judge's final, scoreboard-driven decision — the pipeline's only verdict.

    The Judge verifies the researchers' claims against the technical and
    fundamental reports, checks their intuition's feasibility via web search and
    the historical dataset, weights each metric, and derives the rating from the
    weighted scoreboard.
    """

    rating: PortfolioRating = Field(
        description=(
            "Final rating, exactly one of Buy / Overweight / Hold / Underweight / "
            "Sell, consistent with the sign and magnitude of the weighted score."
        ),
    )
    weighted_score: float = Field(
        description="The weighted-sum score across the scoreboard, -1 to +1.",
    )
    scoreboard: list[ScoreboardEntry] = Field(
        description="The weighted metrics that produced the rating.",
    )
    data_verification: str = Field(
        description=(
            "What the researchers claimed vs. what the technical/fundamental "
            "reports actually support: confirmed claims and any that failed."
        ),
    )
    intuition_feasibility: str = Field(
        description=(
            "Assessment of whether the cited technical win rates are credible, "
            "grounded in the backtest tool, web search, and past records."
        ),
    )
    verdict_summary: str = Field(
        description="The final call in 2-4 sentences, anchored in the scoreboard.",
    )
    price_target: Optional[float] = Field(
        default=None, description="Optional target price in the quote currency.",
    )
    time_horizon: Optional[str] = Field(
        default=None, description="Optional holding period, e.g. '3-6 months'.",
    )


def render_judge_verdict(verdict: JudgeVerdict) -> str:
    """Render a JudgeVerdict to markdown, including a scoreboard table.

    Keeps the ``**Rating**: X`` header so the shared ``parse_rating`` heuristic
    (:mod:`tradingagents.agents.utils.rating`) and the signal processor keep
    working unchanged.
    """
    parts = [
        f"**Rating**: {verdict.rating.value}",
        "",
        f"**Weighted Score**: {verdict.weighted_score:+.2f}",
        "",
        "**Scoreboard**:",
        "",
        "| Metric | Source | Value | Weight | Score | Note |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for e in verdict.scoreboard:
        note = e.note.replace("|", "/")
        parts.append(
            f"| {e.metric} | {e.source} | {e.raw_value} | {e.weight:.2f} | "
            f"{e.score:+.2f} | {note} |"
        )
    parts += [
        "",
        f"**Data Verification**: {verdict.data_verification}",
        "",
        f"**Intuition Feasibility**: {verdict.intuition_feasibility}",
        "",
        f"**Verdict**: {verdict.verdict_summary}",
    ]
    if verdict.price_target is not None:
        parts += ["", f"**Price Target**: {verdict.price_target}"]
    if verdict.time_horizon:
        parts += ["", f"**Time Horizon**: {verdict.time_horizon}"]
    return "\n".join(parts)


def weighted_score(scoreboard: list[ScoreboardEntry]) -> float:
    """Deterministic weighted-sum of a scoreboard, normalised by total weight.

    The Judge fills ``weighted_score`` itself, but this helper lets the
    orchestrator recompute/validate it from the entries so the rating and the
    number can't silently disagree.
    """
    total_w = sum(max(e.weight, 0.0) for e in scoreboard)
    if total_w <= 0:
        return 0.0
    return sum(e.weight * e.score for e in scoreboard) / total_w
