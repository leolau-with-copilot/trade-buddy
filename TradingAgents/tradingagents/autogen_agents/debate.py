"""The live bull vs. bear debate that runs after the Tree-of-Thoughts cases.

After each researcher has presented its ToT case, they enter a multi-round
debate (never fewer than three rounds). On each turn a researcher first
**self-corrects** any mistakes in its earlier statements, then **concedes** the
opponent's valid points and presses **counter-arguments** that expose the
opponent's weaknesses — all grounded strictly in the shared evidence. After the
rounds, a neutral moderator decides whether the two sides can be **compromised**
into a consensus (with agreed sub-points handed to the Judge) or whether their
differences are irreconcilable, in which case the Judge decides everything.

Runs on the reasoning model (``deepseek-reasoner``) via ``complete_json``.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional, Tuple

from tradingagents.agents.schemas import (
    DebateOutcome,
    DebateSpeech,
    render_debate_speech,
)
from .context import RunContext
from .structured import complete_json

# on_turn(side, round_no, summary, content_md) — streams each speech to the UI.
TurnCb = Optional[Callable[[str, int, str, str], None]]


def _shared_evidence(reports: Dict[str, str]) -> str:
    return "\n\n".join([
        "Technical/market report:\n" + (reports.get("market_report") or "n/a"),
        "Fundamentals report:\n" + (reports.get("fundamentals_report") or "n/a"),
        "News report:\n" + (reports.get("news_report") or "n/a"),
        "Sentiment report:\n" + (reports.get("sentiment_report") or "n/a"),
    ])


async def _speak(
    ctx: RunContext, *, side: str, round_no: int,
    own_case: str, opponent_latest: str, transcript: str, evidence: str,
) -> DebateSpeech:
    system = (
        f"You are the {side} researcher in round {round_no} of a live debate with "
        f"the opposing researcher. FIRST self-correct any mistakes in YOUR earlier "
        f"statements this debate. THEN concede the opponent's genuinely valid points "
        f"and press sharp counter-arguments that expose the weaknesses and overstated "
        f"claims in their latest case. Ground every point strictly in the shared "
        f"evidence — do not invent facts.{ctx.language_instruction}"
    )
    user = (
        f"Your case:\n{own_case}\n\n"
        f"Opponent's latest case:\n{opponent_latest}\n\n"
        f"Debate so far:\n{transcript or '(opening round — no turns yet)'}\n\n"
        f"Shared evidence:\n{evidence}"
    )
    return await complete_json(ctx.deep_client, system=system, user=user, schema=DebateSpeech)


async def _consensus(ctx: RunContext, evidence: str, transcript: str) -> DebateOutcome:
    system = (
        "You are a neutral debate moderator. Read the full bull/bear debate and "
        "decide whether the two sides can be COMPROMISED into a single consensus "
        "view. If they can, set consensus_reached=true, write a 'consensus_summary' "
        "and the 'sub_points' both sides accept. If they cannot, set "
        "consensus_reached=false and list 'remaining_disagreements'. Decide strictly "
        f"from the transcript and evidence.{ctx.language_instruction}"
    )
    user = f"Debate transcript:\n{transcript}\n\nShared evidence:\n{evidence}"
    return await complete_json(ctx.deep_client, system=system, user=user, schema=DebateOutcome)


async def run_debate(
    ctx: RunContext,
    reports: Dict[str, str],
    bull_case: str,
    bear_case: str,
    *,
    rounds: int = 3,
    on_turn: TurnCb = None,
) -> Tuple[str, DebateOutcome, List[dict]]:
    """Run the alternating debate, then the consensus check.

    Returns ``(transcript_md, outcome, turns)`` where ``turns`` is a list of
    ``{side, round, summary, content}`` dicts (also streamed via ``on_turn``).
    The debate is never shorter than three rounds.
    """
    rounds = max(3, int(rounds))
    evidence = _shared_evidence(reports)
    transcript_parts: List[str] = []
    turns: List[dict] = []
    bull_latest, bear_latest = bull_case, bear_case

    async def turn(side: str, round_no: int, own: str, opp: str) -> str:
        sp = await _speak(
            ctx, side=side, round_no=round_no, own_case=own, opponent_latest=opp,
            transcript="\n\n".join(transcript_parts), evidence=evidence,
        )
        md = render_debate_speech(side.capitalize(), round_no, sp)
        transcript_parts.append(md)
        turns.append({"side": side, "round": round_no, "summary": sp.summary, "content": md})
        if on_turn:
            on_turn(side, round_no, sp.summary, md)
        return md

    for r in range(1, rounds + 1):
        bull_latest = await turn("bull", r, bull_case, bear_latest)
        bear_latest = await turn("bear", r, bear_case, bull_latest)

    transcript_md = "\n\n".join(transcript_parts)
    outcome = await _consensus(ctx, evidence, transcript_md)
    return transcript_md, outcome, turns
