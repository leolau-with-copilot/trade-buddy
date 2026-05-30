"""A Tree-of-Thoughts controller with self-examination, used by the researchers.

Flow: generate several candidate lines of argument ("thoughts"), each laid out
as a **fact → reasoning → conclusion** chain; have the model **self-examine**
each one — estimating the *likelihood* (probability) it actually holds given the
data and critiquing its own weaknesses; keep the most likely few; expand them
another round; then synthesize a case **weighted by those likelihoods** that
explicitly addresses the surfaced weaknesses. Each step is a JSON completion
(``complete_json``), so the controller is provider-agnostic and unit-testable
with a fake client.

It runs on the deep reasoning model (``deepseek-reasoner``), which has no reliable
tool calling — hence the researchers ground their technical claims *after* the ToT
search via the deterministic backfill in
:func:`tradingagents.autogen_agents.runtime_tools.ground_signal_claims`.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, List

from pydantic import BaseModel

from .structured import complete_json

logger = logging.getLogger(__name__)


class _StructuredThought(BaseModel):
    """One line of argument expressed as fact → reasoning → conclusion."""

    fact: str       # the concrete, verifiable observation the line starts from
    reasoning: str  # how that fact is interpreted for this side
    conclusion: str # the directional takeaway the line lands on


class _ThoughtList(BaseModel):
    thoughts: List[_StructuredThought]


class _ThoughtEval(BaseModel):
    likelihood: float          # self-assessed P(argument holds | data), 0-1
    critique: str              # the argument's main weakness / what could break it


class _Synthesis(BaseModel):
    argument: str
    paths_summary: str


@dataclass
class Thought:
    """One explored fact→reasoning→conclusion line with its self-examination."""

    fact: str
    reasoning: str
    conclusion: str
    likelihood: float
    critique: str

    @property
    def text(self) -> str:
        """Flat form fed back into prompts (examination / expansion)."""
        return (f"Fact: {self.fact} Reasoning: {self.reasoning} "
                f"Conclusion: {self.conclusion}")


@dataclass
class ToTResult:
    """Outcome of a Tree-of-Thoughts search."""

    argument: str                       # the synthesized, likelihood-weighted case
    paths_summary: str                  # note on paths explored / why the winner won
    explored: List[Thought] = field(default_factory=list)
    top: List[Thought] = field(default_factory=list)   # the kept, highest-likelihood lines

    def render_chain(self) -> str:
        """Render kept thoughts as vertical fact→reasoning→conclusion chains.

        Each thought is a paragraph; within it, the steps are stacked on their
        own lines (Markdown hard breaks via two trailing spaces) linked by ``—>``
        arrows, with the probability on its own line beside the reasoning::

            [Fact: ...]
            —>
            [Reasoning: ...]
            probability 72%
            —>
            [Conclusion: ...]

        The CLI paints these rows red; the web app styles the brackets, arrows,
        and probability. Ordered most-likely first.
        """
        if not self.top:
            return ""
        out = ["", "**Tree-of-Thoughts paths** (fact, reasoning, conclusion):", ""]
        for t in self.top:
            clean = lambda s: " ".join((s or "").strip().split())
            rows = [
                f"[Fact: {clean(t.fact)}]",
                "—>",
                f"[Reasoning: {clean(t.reasoning)}]",
                f"probability {t.likelihood:.0%}",
                "—>",
                f"[Conclusion: {clean(t.conclusion)}]",
            ]
            # Two trailing spaces = Markdown hard break, so each step renders on
            # its own line in the browser as well as the CLI.
            out.append("  \n".join(rows))
            out.append("")  # blank line → new paragraph per path
        return "\n".join(out).rstrip()


async def _complete_json(client: Any, system: str, user: str, schema: type[BaseModel]):
    """One JSON-structured completion parsed into ``schema`` (DeepSeek-safe)."""
    return await complete_json(client, system=system, user=user, schema=schema)


def _to_thoughts(items: List[_StructuredThought], side_label: str) -> List[_StructuredThought]:
    valid = [t for t in items if (t.fact.strip() or t.conclusion.strip())]
    if not valid:
        valid = [_StructuredThought(
            fact="Available reports for the instrument.",
            reasoning=f"General {side_label} reading of the evidence.",
            conclusion=f"A {side_label} stance is defensible.",
        )]
    return valid


async def tree_of_thoughts(
    client: Any,
    *,
    side_label: str,
    problem: str,
    context: str,
    breadth: int = 4,
    depth: int = 1,
    keep: int = 3,
    language_instruction: str = "",
) -> ToTResult:
    """Run a self-examining ToT search for one side of the debate.

    Args:
        client: reasoning model client.
        side_label: "bullish" or "bearish".
        problem: the question being argued (e.g. "Should we buy TICKER?").
        context: analyst reports + opponent's last case + signal catalog.
        breadth: candidate thoughts generated per expansion.
        depth: extra expansion rounds after the initial generation.
        keep: how many top thoughts survive each round / feed the synthesis.
        language_instruction: localisation suffix so the fact/reasoning/conclusion
            text is written in the user's chosen language (JSON keys stay English).
    """
    # Localise the JSON string *values* while keeping the schema keys in English
    # so parsing still works. Appended to every prompt in the search.
    lang = (
        f"{language_instruction} Keep the JSON field names in English, but write "
        f"the fact/reasoning/conclusion/critique/argument text in the requested "
        f"language." if language_instruction else ""
    )
    gen_system = (
        f"You are a {side_label} equity researcher. Propose {breadth} DISTINCT, "
        f"non-overlapping lines of {side_label} argument grounded in the context. "
        f"Each thought MUST reason from the ground up: start with a concrete, "
        f"verifiable 'fact' from the data, then 'reasoning' that interprets it for "
        f"the {side_label} side, then the 'conclusion' it leads to. Favour viable, "
        f"defensible lines over weak ones.{lang}"
    )
    gen = await _complete_json(
        client, gen_system, f"{problem}\n\nContext:\n{context}", _ThoughtList
    )
    thoughts = _to_thoughts(gen.thoughts, side_label)[:breadth]

    async def examine(st: _StructuredThought) -> Thought:
        """Self-examination: likelihood the line holds + its main weakness."""
        flat = (f"Fact: {st.fact} Reasoning: {st.reasoning} "
                f"Conclusion: {st.conclusion}")
        ev = await _complete_json(
            client,
            "Critically self-examine this fact→reasoning→conclusion argument for "
            "the stated side. Estimate 'likelihood' = your honest probability (0-1) "
            "that it actually holds given the data — penalise claims the context "
            "does not support — and give 'critique' = its single biggest weakness "
            "or what could break it." + lang,
            f"Side: {side_label}\nArgument: {flat}\n\nContext:\n{context}",
            _ThoughtEval,
        )
        return Thought(
            fact=st.fact, reasoning=st.reasoning, conclusion=st.conclusion,
            likelihood=max(0.0, min(1.0, float(ev.likelihood))), critique=ev.critique,
        )

    explored: List[Thought] = list(await asyncio.gather(*(examine(t) for t in thoughts)))
    frontier = explored

    # Expansion rounds: deepen the most-likely surviving thoughts.
    for _ in range(max(0, depth)):
        survivors = sorted(frontier, key=lambda x: x.likelihood, reverse=True)[:keep]
        expand_system = (
            f"Deepen this {side_label} line into {breadth} sharper, more specific "
            f"sub-arguments. Each keeps the fact→reasoning→conclusion shape, cites "
            f"concrete evidence, and pre-empts the noted weakness.{lang}"
        )
        expansions = await asyncio.gather(*(
            _complete_json(
                client, expand_system,
                f"Line: {t.text}\nKnown weakness: {t.critique}\n\nContext:\n{context}",
                _ThoughtList,
            )
            for t in survivors
        ))
        children = [c for ex in expansions for c in _to_thoughts(ex.thoughts, side_label)]
        if not children:
            break
        frontier = list(await asyncio.gather(*(examine(c) for c in children)))
        explored.extend(frontier)

    best = sorted(explored, key=lambda x: x.likelihood, reverse=True)[:keep]
    total = sum(t.likelihood for t in best) or 1.0
    best_block = "\n".join(
        f"- weight {t.likelihood / total:.0%} (likelihood {t.likelihood:.2f}): "
        f"{t.text}  [weakness: {t.critique}]"
        for t in best
    )
    synth = await _complete_json(
        client,
        f"Synthesize the strongest {side_label} case from these self-examined "
        f"branches. Weight each branch by its likelihood weight: lean hardest on "
        f"the most-likely lines and explicitly address the noted weaknesses. "
        f"'argument' = a tight, persuasive case in prose. 'paths_summary' = one or "
        f"two sentences on which branches were explored, their likelihood weights, "
        f"and why the winning line was chosen.{lang}",
        f"Self-examined branches for the {side_label} side (with likelihood "
        f"weights and weaknesses):\n{best_block}\n\nContext:\n{context}",
        _Synthesis,
    )
    return ToTResult(
        argument=synth.argument,
        paths_summary=synth.paths_summary,
        explored=explored,
        top=best,
    )
