"""Tests for the AutoGen pipeline building blocks (offline, fake model clients)."""

import json
import os
import tempfile
from types import SimpleNamespace

import pytest

from tradingagents.agents.schemas import (
    BearCase, BullCase, JudgeVerdict, PortfolioRating, ScoreboardEntry,
    SignalClaim, render_judge_verdict, weighted_score,
)
from tradingagents.autogen_agents import RunContext
from tradingagents.autogen_agents.runtime_tools import ground_signal_claims, make_judge_tools
from tradingagents.datastore import AnalysisStore
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.dataflows.config import set_config


# --- model client -----------------------------------------------------------

def test_model_client_tool_capability():
    os.environ.setdefault("DEEPSEEK_API_KEY", "dummy")
    from tradingagents.autogen_clients import create_model_client, is_tool_calling_model
    assert is_tool_calling_model("deepseek-chat")
    assert not is_tool_calling_model("deepseek-reasoner")
    chat = create_model_client("deepseek-chat")
    reasoner = create_model_client("deepseek-reasoner")
    assert chat.model_info["function_calling"] is True
    assert reasoner.model_info["function_calling"] is False


def test_model_client_requires_key(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    from tradingagents.autogen_clients import create_model_client
    with pytest.raises(ValueError):
        create_model_client("deepseek-chat")


def test_reasoning_content_roundtrip(monkeypatch):
    """DeepSeek thinking-mode reasoning_content must be echoed back on replay.

    Without this, multi-turn tool loops 400 with "The reasoning_content in the
    thinking mode must be passed back to the API."
    """
    monkeypatch.setenv("DEEPSEEK_API_KEY", "dummy")
    from autogen_core import FunctionCall
    from autogen_core.models import (
        AssistantMessage, FunctionExecutionResult,
        FunctionExecutionResultMessage, SystemMessage, UserMessage,
    )
    from tradingagents.autogen_clients import create_model_client

    client = create_model_client("deepseek-chat")
    msgs = [
        SystemMessage(content="sys"),
        UserMessage(content="analyze AAPL", source="user"),
        AssistantMessage(
            content=[FunctionCall(id="c1", name="get_stock_data", arguments="{}")],
            thought="reasoning here", source="assistant",
        ),
        FunctionExecutionResultMessage(content=[FunctionExecutionResult(
            call_id="c1", content="csv", is_error=False, name="get_stock_data")]),
        UserMessage(content="continue", source="user"),
    ]
    params = client._process_create_args(msgs, [], "auto", None, {})
    asst = [m for m in params.messages if m.get("role") == "assistant"][0]
    assert asst["reasoning_content"] == "reasoning here"
    assert asst["content"] == ""           # thought no longer duplicated in content
    assert asst.get("tool_calls")          # tool call preserved

    # A turn with no thought is left untouched (safe for non-thinking models).
    msgs2 = [
        UserMessage(content="hi", source="user"),
        AssistantMessage(content="plain", source="assistant", thought=None),
        UserMessage(content="again", source="user"),
    ]
    a2 = [m for m in client._process_create_args(msgs2, [], "auto", None, {}).messages
          if m.get("role") == "assistant"][0]
    assert "reasoning_content" not in a2
    assert a2["content"] == "plain"


def test_tool_adapters_schema():
    from tradingagents.autogen_clients import analyst_tools
    names = {t.name for t in analyst_tools("market")}
    assert names == {"get_stock_data", "get_indicators"}
    assert {t.name for t in analyst_tools("fundamentals")} == {
        "get_fundamentals", "get_balance_sheet", "get_cashflow",
        "get_income_statement", "get_sec_filings",
    }
    # News analyst gains structured macro tools alongside global/company news.
    assert {t.name for t in analyst_tools("news")} == {
        "get_news", "get_global_news",
        "get_economic_indicator", "get_macro_snapshot",
    }
    # Smart-money analyst owns the corporate-insider + congressional feeds.
    assert {t.name for t in analyst_tools("smart_money")} == {
        "get_insider_transactions", "get_congress_trading",
    }


# --- helpers ----------------------------------------------------------------

def _ctx(tmp):
    set_config(DEFAULT_CONFIG.copy())
    return RunContext(
        ticker="AAPL", trade_date="2026-01-15", asset_type="stock",
        config=DEFAULT_CONFIG.copy(), store=AnalysisStore(os.path.join(tmp, "a.db")),
        chat_client=None, deep_client=None, language_instruction="",
    )


# --- grounding --------------------------------------------------------------

def test_ground_signal_claims_drops_unknown_and_fills_real_winrate():
    with tempfile.TemporaryDirectory() as tmp:
        ctx = _ctx(tmp)
        claims = [
            SignalClaim(indicator="macd", signal="macd_bull_cross",
                        claimed_winrate=0.9, rationale="cross"),
            SignalClaim(indicator="fake", signal="hallucinated_signal",
                        claimed_winrate=0.99, rationale="made up"),
        ]
        grounded = ground_signal_claims(ctx, claims)
        assert len(grounded) == 1
        assert grounded[0].signal == "macd_bull_cross"
        # backtest_winrate is now the real number, overriding the model's claim.
        assert grounded[0].backtest_winrate is not None
        assert grounded[0].n_occurrences is not None


def test_make_judge_tools_names():
    with tempfile.TemporaryDirectory() as tmp:
        tools = make_judge_tools(_ctx(tmp))
        assert {t.name for t in tools} == {
            "get_technical_winrate", "lookup_signal_history", "lookup_past_analyses"
        }


# --- Tree of Thoughts (fake reasoning client) -------------------------------

def _sys_text(messages):
    """The system message content (complete_json embeds the schema there)."""
    for m in messages:
        if type(m).__name__ == "SystemMessage":
            return m.content
    return ""


def _structured_thoughts():
    return {"thoughts": [
        {"fact": "momentum rising", "reasoning": "trend strong", "conclusion": "buy"},
        {"fact": "valuation fair", "reasoning": "cheap vs peers", "conclusion": "buy"},
        {"fact": "breakout", "reasoning": "volume confirms", "conclusion": "buy"},
    ]}


class _FakeToTClient:
    async def create(self, messages, *, tools=None, **kw):
        sys = _sys_text(messages)
        if "_ThoughtList" in sys:
            payload = _structured_thoughts()
        elif "_ThoughtEval" in sys:
            payload = {"likelihood": 0.7, "critique": "could reverse"}
        elif "_Synthesis" in sys:
            payload = {"argument": "strong case", "paths_summary": "momentum won"}
        else:
            payload = {}
        return SimpleNamespace(content=json.dumps(payload), thought=None)


@pytest.mark.asyncio
async def test_tree_of_thoughts_runs():
    from tradingagents.autogen_agents.tot import tree_of_thoughts
    res = await tree_of_thoughts(
        _FakeToTClient(), side_label="bullish",
        problem="buy?", context="reports", breadth=3, depth=1, keep=2,
    )
    assert res.argument == "strong case"
    assert "momentum" in res.paths_summary
    assert len(res.explored) >= 3
    # kept thoughts feed a vertical fact→reasoning→conclusion chain.
    assert res.top and len(res.top) <= 2
    chain = res.render_chain()
    assert "Tree-of-Thoughts paths" in chain
    assert "[Fact:" in chain and "[Conclusion:" in chain and "probability" in chain
    assert "—>" in chain


# --- researchers (fake client wired through ToT + synthesis) ----------------

class _FakeResearchClient:
    async def create(self, messages, *, tools=None, **kw):
        sys = _sys_text(messages)
        if "_ThoughtList" in sys:
            payload = _structured_thoughts()
        elif "_ThoughtEval" in sys:
            payload = {"likelihood": 0.8, "critique": "x"}
        elif "_Synthesis" in sys:
            payload = {"argument": "case", "paths_summary": "summary"}
        elif "BullCase" in sys:
            payload = {"thesis": "up", "key_points": ["m"], "tot_summary": "s",
                       "conviction": 0.7, "signals": [
                           {"indicator": "macd", "signal": "macd_bull_cross",
                            "claimed_winrate": 0.7, "rationale": "cross"}]}
        elif "BearCase" in sys:
            payload = {"thesis": "down", "key_points": ["r"], "tot_summary": "s",
                       "conviction": 0.4, "signals": []}
        else:
            payload = {}
        return SimpleNamespace(content=json.dumps(payload), thought=None)


@pytest.mark.asyncio
async def test_run_bull_grounds_signals():
    from tradingagents.autogen_agents.researchers import run_bull
    with tempfile.TemporaryDirectory() as tmp:
        ctx = _ctx(tmp)
        ctx.deep_client = _FakeResearchClient()
        case, md = await run_bull(ctx, {"market_report": "macd cross"})
        assert isinstance(case, BullCase)
        assert case.signals and case.signals[0].backtest_winrate is not None
        assert "Bull Thesis" in md
        # the ToT reasoning chain is appended to the rendered case.
        assert "Tree-of-Thoughts paths" in md and "—>" in md


# --- debate (≥3 rounds, consensus check) ------------------------------------

class _FakeDebateClient:
    async def create(self, messages, *, tools=None, **kw):
        sys = _sys_text(messages)
        if "DebateSpeech" in sys:
            payload = {"self_correction": "No correction needed.",
                       "concessions": ["valid point"], "counters": ["weak there"],
                       "summary": "press the trend"}
        elif "DebateOutcome" in sys:
            payload = {"consensus_reached": False, "consensus_summary": "",
                       "sub_points": [], "remaining_disagreements": ["direction"]}
        else:
            payload = {}
        return SimpleNamespace(content=json.dumps(payload), thought=None)


@pytest.mark.asyncio
async def test_run_debate_enforces_min_three_rounds():
    from tradingagents.autogen_agents.debate import run_debate
    with tempfile.TemporaryDirectory() as tmp:
        ctx = _ctx(tmp)
        ctx.deep_client = _FakeDebateClient()
        seen = []
        transcript, outcome, turns = await run_debate(
            ctx, {"market_report": "m"}, "bull md", "bear md",
            rounds=1, on_turn=lambda *a: seen.append(a),  # asks for 1, gets >=3
        )
        assert len(turns) == 6          # 3 rounds × (bull + bear)
        assert len(seen) == 6
        assert outcome.consensus_reached is False
        assert "round 1" in transcript.lower() and "round 3" in transcript.lower()


# --- pipeline gating + token usage events -----------------------------------

@pytest.mark.asyncio
async def test_only_selected_analyst_runs(monkeypatch):
    """Selecting one analyst must run exactly that analyst — no others."""
    import tradingagents.graph.orchestrator as orch
    from tradingagents.agents.schemas import (
        BearCase, BullCase, DebateOutcome, JudgeVerdict, PortfolioRating,
        ScoreboardEntry,
    )

    ran: list[str] = []

    async def fake_run_analyst(key, ctx):
        ran.append(key)
        return f"{key} report"

    async def fake_run_bull(ctx, reports, opponent_case=None):
        return BullCase(thesis="u", key_points=["m"], tot_summary="s",
                        conviction=0.6, signals=[]), "bull md"

    async def fake_run_bear(ctx, reports, opponent_case=None):
        return BearCase(thesis="d", key_points=["r"], tot_summary="s",
                        conviction=0.4, signals=[]), "bear md"

    async def fake_run_debate(ctx, reports, b, be, *, rounds, on_turn=None):
        return "transcript", DebateOutcome(
            consensus_reached=True, consensus_summary="c",
            sub_points=[], remaining_disagreements=[]), []

    async def fake_run_judge(ctx, reports, bc, bm, brc, brm, debate_md="", outcome_md=""):
        v = JudgeVerdict(
            rating=PortfolioRating.HOLD, weighted_score=0.0,
            scoreboard=[ScoreboardEntry(metric="m", source="technical",
                                        raw_value="x", weight=1.0, score=0.0, note="ok")],
            data_verification="d", intuition_feasibility="i", verdict_summary="hold")
        return v, "verdict md", 1

    monkeypatch.setattr(orch, "run_analyst", fake_run_analyst)
    monkeypatch.setattr(orch, "run_bull", fake_run_bull)
    monkeypatch.setattr(orch, "run_bear", fake_run_bear)
    monkeypatch.setattr(orch, "run_debate", fake_run_debate)
    monkeypatch.setattr(orch, "run_judge", fake_run_judge)

    events: list[tuple] = []

    with tempfile.TemporaryDirectory() as tmp:
        ctx = _ctx(tmp)
        await orch.run_analysis(
            ctx, ["market"], on_event=lambda *a: events.append(a),
        )

    assert ran == ["market"]  # only the selected analyst ran
    # usage pseudo-events were emitted so the token tracker can refresh live.
    assert any(e[1] == "usage" for e in events)
    # the debate streamed its consensus outcome.
    assert any(e[1] == "consensus" for e in events)


# --- judge glue (persistence + weighted-score recompute) --------------------

@pytest.mark.asyncio
async def test_run_judge_persists_and_recomputes(monkeypatch):
    import tradingagents.autogen_agents.judge as judge_mod
    with tempfile.TemporaryDirectory() as tmp:
        ctx = _ctx(tmp)
        bull = BullCase(thesis="u", key_points=["m"], tot_summary="s", conviction=0.7,
                        signals=[SignalClaim(indicator="macd", signal="macd_bull_cross",
                                             claimed_winrate=0.7, backtest_winrate=0.65,
                                             n_occurrences=34, rationale="x")])
        bear = BearCase(thesis="d", key_points=["r"], tot_summary="s", conviction=0.3, signals=[])
        verdict = JudgeVerdict(
            rating=PortfolioRating.OVERWEIGHT, weighted_score=99.0,  # wrong on purpose
            scoreboard=[
                ScoreboardEntry(metric="m", source="technical", raw_value="x",
                                weight=0.5, score=0.8, note="ok"),
                ScoreboardEntry(metric="v", source="fundamental", raw_value="y",
                                weight=0.5, score=-0.2, note="pe"),
            ],
            data_verification="dv", intuition_feasibility="if", verdict_summary="net bull",
        )

        async def fake_verify(c, t):
            return "free-text analysis"

        async def fake_to_verdict(c, analysis, task):
            return verdict
        monkeypatch.setattr(judge_mod, "_verify_with_tools", fake_verify)
        monkeypatch.setattr(judge_mod, "_to_verdict", fake_to_verdict)

        v, md, aid = await judge_mod.run_judge(
            ctx, {"market_report": "m", "fundamentals_report": "f"},
            bull, "bull md", bear, "bear md",
        )
        assert v.weighted_score == pytest.approx(0.3)  # recomputed from scoreboard
        assert "| Metric | Source |" in md
        rows = ctx.store.past_analyses("AAPL")
        assert rows[0]["final_rating"] == "Overweight"
        # cited signals persisted
        assert ctx.store.signal_history_winrate("macd_bull_cross")["avg_backtest_winrate"] is None  # no outcome yet


# --- schema render ----------------------------------------------------------

def test_weighted_score_normalised():
    sb = [
        ScoreboardEntry(metric="a", source="technical", raw_value="x", weight=0.5, score=1.0, note=""),
        ScoreboardEntry(metric="b", source="fundamental", raw_value="y", weight=0.5, score=-1.0, note=""),
    ]
    assert weighted_score(sb) == pytest.approx(0.0)


def test_render_judge_verdict_has_rating_header():
    v = JudgeVerdict(rating=PortfolioRating.BUY, weighted_score=0.6,
                     scoreboard=[ScoreboardEntry(metric="m", source="technical",
                                                 raw_value="x", weight=1.0, score=0.6, note="ok")],
                     data_verification="dv", intuition_feasibility="if", verdict_summary="buy")
    md = render_judge_verdict(v)
    assert md.startswith("**Rating**: Buy")
    from tradingagents.agents.utils.rating import parse_rating
    assert parse_rating(md) == "Buy"
