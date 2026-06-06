"""Independent AI macro/markets analyst for the dashboard.

A standalone conversational agent (separate from the analysis pipeline). It is
pre-fed the current macro snapshot, and can call tools to fetch specifics and
**quote real figures**:

* ``get_economic_indicator`` / ``get_macro_snapshot`` — live FRED data.
* ``get_global_news`` / ``get_news`` — market and ticker news.
* ``lookup_past_analyses`` / ``list_recent_analyses`` — the SQLite analysis
  store, so it can cite prior verdicts and their realised outcomes.

The server is stateless per request; the client sends recent history, which is
replayed as context. The macro snapshot is cached briefly so chatting doesn't
re-hit FRED on every message.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import List, Optional

from autogen_agentchat.agents import AssistantAgent
from autogen_core.tools import FunctionTool

from tradingagents.autogen_agents.analysts import strip_raw_tool_calls
from tradingagents.autogen_clients import create_model_client
from tradingagents.autogen_clients.tools import (
    get_balance_sheet_tool,
    get_cashflow_tool,
    get_congress_trading_tool,
    get_economic_indicator_tool,
    get_fundamentals_tool,
    get_global_news_tool,
    get_income_statement_tool,
    get_indicators_tool,
    get_insider_transactions_tool,
    get_institutional_holders_tool,
    get_macro_snapshot_tool,
    get_news_tool,
    get_sec_filings_tool,
    get_stock_data_tool,
)
from tradingagents.datastore import AnalysisStore
from tradingagents.datastore.analysis_store import default_store_path
from tradingagents.dataflows.config import get_config

logger = logging.getLogger(__name__)

_SNAPSHOT_CACHE = {"text": "", "ts": 0.0}
_SNAPSHOT_TTL = 600  # seconds


def _cached_snapshot() -> str:
    now = time.time()
    if _SNAPSHOT_CACHE["text"] and now - _SNAPSHOT_CACHE["ts"] < _SNAPSHOT_TTL:
        return _SNAPSHOT_CACHE["text"]
    try:
        from tradingagents.dataflows.macro_utils import get_macro_snapshot

        text = get_macro_snapshot("")
    except Exception as exc:  # noqa: BLE001
        logger.warning("snapshot for chat failed: %s", exc)
        text = "Macro snapshot unavailable."
    _SNAPSHOT_CACHE.update(text=text, ts=now)
    return text


def _store() -> AnalysisStore:
    return AnalysisStore(default_store_path(get_config()["data_cache_dir"]))


def _lookup_past_analyses(ticker: str) -> str:
    """Past analyses for a ticker from the database, with realised outcomes."""
    try:
        rows = _store().past_analyses(ticker.strip().upper(), limit=5)
    except Exception as exc:  # noqa: BLE001
        return f"Could not read the analysis database: {exc}"
    if not rows:
        return f"NOT IN DATABASE: no past analyses for {ticker.upper()}. Use the live data tools instead."
    out = [f"Past analyses for {ticker.upper()} (most recent first):"]
    for r in rows:
        line = (f"- {r.get('trade_date')}: rating={r.get('final_rating')}, "
                f"score={r.get('weighted_score') if 'weighted_score' in r else r.get('final_rating')}")
        if r.get("alpha_return") is not None:
            line += f", realised alpha={r['alpha_return']:.2%} over {r.get('holding_days')}d"
        out.append(line)
    return "\n".join(out)


def _get_stored_analysis(ticker: str) -> str:
    """Full stored verdict + scoreboard for a ticker's most recent analysis.

    This is the detailed record behind ``lookup_past_analyses`` — the actual
    judge verdict text and the weighted metric scoreboard, so the agent can
    explain *why* a prior rating was reached, not just quote the number.
    """
    sym = ticker.strip().upper()
    try:
        store = _store()
        with store._conn() as conn:  # noqa: SLF001 — internal read is fine here
            a = conn.execute(
                "SELECT * FROM analyses WHERE ticker = ? "
                "ORDER BY trade_date DESC, id DESC LIMIT 1", (sym,),
            ).fetchone()
            if a is None:
                return f"NOT IN DATABASE: no stored analysis for {sym}. Use the live data tools instead."
            a = dict(a)
            board = [dict(r) for r in conn.execute(
                "SELECT metric, source, raw_value, weight, score, note FROM scoreboard "
                "WHERE analysis_id = ? ORDER BY weight DESC", (a["id"],),
            ).fetchall()]
    except Exception as exc:  # noqa: BLE001
        return f"Could not read the analysis database: {exc}"
    out = [f"Stored analysis for {sym} ({a.get('trade_date')}): "
           f"rating={a.get('final_rating')}, weighted_score={a.get('weighted_score')}"]
    if board:
        out.append("Scoreboard (metric · source · value · weight · score · note):")
        for r in board:
            out.append(f"- {r['metric']} · {r['source']} · {r['raw_value']} · "
                       f"w={r['weight']} · s={r['score']} · {r.get('note') or ''}")
    if a.get("verdict_md"):
        out.append("\nVerdict:\n" + str(a["verdict_md"])[:2000])
    return "\n".join(out)


def _list_recent_analyses(limit: int = 10) -> str:
    """Most recent analyses across all tickers in the database."""
    try:
        store = _store()
        with store._conn() as conn:  # noqa: SLF001 — internal read is fine here
            rows = conn.execute(
                "SELECT ticker, trade_date, final_rating FROM analyses "
                "ORDER BY trade_date DESC, id DESC LIMIT ?", (int(limit),),
            ).fetchall()
        rows = [dict(r) for r in rows]
    except Exception as exc:  # noqa: BLE001
        return f"Could not read the analysis database: {exc}"
    if not rows:
        return "The analysis database has no records yet."
    return "Recent analyses:\n" + "\n".join(
        f"- {r['trade_date']} {r['ticker']}: {r['final_rating']}" for r in rows
    )


def record_message(
    channel: str, role: str, content: str,
    session_id: Optional[str] = None, ticker: Optional[str] = None,
) -> None:
    """Persist one chat turn to the conversation log (best-effort, never raises).

    Called by the HTTP layer for both the dashboard chat and the clawbot path so
    every exchange is durable and the agent can recall it later.
    """
    try:
        _store().record_message(
            channel=channel, role=role, content=content,
            session_id=session_id, ticker=ticker,
        )
    except Exception as exc:  # noqa: BLE001 - logging must never break a reply
        logger.warning("could not record conversation turn: %s", exc)


def _lookup_past_conversations(query: str = "", limit: int = 12) -> str:
    """Search Trade Buddy's own past conversations (all channels) for context.

    Pass a keyword/ticker to search message text, or leave blank for the most
    recent turns. This is how the agent recalls what it (or the clawbot) already
    discussed, since each HTTP request is otherwise stateless.
    """
    try:
        store = _store()
        rows = (store.search_messages(query.strip(), limit=limit)
                if query.strip() else store.recent_messages(limit=limit))
    except Exception as exc:  # noqa: BLE001
        return f"Could not read the conversation log: {exc}"
    if not rows:
        return "No matching past conversations were found."
    out = ["Past conversation turns (most relevant/recent first):"]
    for r in rows:
        who = r.get("role", "?")
        tag = f" [{r['ticker']}]" if r.get("ticker") else ""
        when = (r.get("created_at") or "")[:16]
        text = (r.get("content") or "").replace("\n", " ")
        out.append(f"- {when} ({r.get('channel')}/{who}){tag}: {text[:240]}")
    return "\n".join(out)


def _run_full_analysis(ticker: str, date: str = "") -> str:
    """Commission the FULL multi-agent analyst team to analyze ``ticker``.

    Use this only when the database has no usable analysis and the user wants a
    fresh, rigorous verdict (Analysts → Bull/Bear debate → Judge). It runs the
    real pipeline, which takes a few minutes, then PERSISTS the result to the
    database before returning the verdict — so it is afterwards retrievable via
    ``get_stored_analysis`` / ``lookup_past_analyses``.
    """
    from webapp.analysis_runner import run_analysis_blocking

    sym = ticker.strip().upper()
    if not sym:
        return "Provide a ticker symbol to analyze."
    try:
        res = run_analysis_blocking(sym, (date or "").strip() or None)
    except Exception as exc:  # noqa: BLE001
        return f"The analyst team could not complete the run for {sym}: {exc}"
    out = [
        f"Completed full analysis for {sym} ({res.get('trade_date')}) and saved it "
        f"to the database (analysis_id={res.get('analysis_id')}).",
        f"Rating: {res.get('rating')} · weighted_score: {res.get('weighted_score')} "
        f"· decision: {res.get('decision')}",
    ]
    board = res.get("scoreboard") or []
    if board:
        out.append("Scoreboard (metric · weight · score):")
        for r in board[:12]:
            out.append(f"- {r.get('metric')} · w={r.get('weight')} · s={r.get('score')}")
    if res.get("verdict_md"):
        out.append("\nVerdict:\n" + str(res["verdict_md"])[:2000])
    return "\n".join(out)


async def _run_full_analysis_async(ticker: str, date: str = "") -> str:
    """Async wrapper so the minutes-long pipeline never blocks the event loop."""
    return await asyncio.to_thread(_run_full_analysis, ticker, date)


def _get_social_sentiment(ticker: str) -> str:
    """Retail / social sentiment for a ticker — the sentiment analyst's raw feeds:
    StockTwits (bull/bear tagged messages), Finnhub social scores, and Google
    search interest over the past week."""
    sym = ticker.strip().upper()
    if not sym:
        return "Provide a ticker symbol."
    import datetime as _dt

    end = _dt.date.today().isoformat()
    start = (_dt.date.today() - _dt.timedelta(days=7)).isoformat()
    parts = []
    try:
        from tradingagents.dataflows.stocktwits import fetch_stocktwits_messages
        parts.append("## StockTwits (retail, bull/bear tagged)\n" + str(fetch_stocktwits_messages(sym, limit=25)))
    except Exception as exc:  # noqa: BLE001
        parts.append(f"StockTwits unavailable: {exc}")
    try:
        from tradingagents.dataflows.finnlp_sources import get_finnhub_sentiment, get_google_trends
        parts.append("## Finnhub social sentiment\n" + str(get_finnhub_sentiment(sym, start, end)))
        parts.append("## Google search interest\n" + str(get_google_trends(sym, start, end)))
    except Exception as exc:  # noqa: BLE001
        parts.append(f"Finnhub / Google Trends unavailable: {exc}")
    return "\n\n".join(parts)


async def _get_social_sentiment_async(ticker: str) -> str:
    return await asyncio.to_thread(_get_social_sentiment, ticker)


_social_sentiment_tool = FunctionTool(
    _get_social_sentiment_async, name="get_social_sentiment",
    description="Retail/social sentiment for a ticker: StockTwits bull/bear messages, Finnhub social scores, and Google search interest (the sentiment analyst's raw feeds).",
)
_lookup_conversations_tool = FunctionTool(
    _lookup_past_conversations, name="lookup_past_conversations",
    description="Search Trade Buddy's own past conversation log (dashboard + clawbot) by keyword/ticker, or recent turns if blank. Use to recall what was already discussed.",
)
_run_analysis_tool = FunctionTool(
    _run_full_analysis_async, name="run_full_analysis",
    description="Commission the FULL analyst team (Analysts→Bull/Bear→Judge) to analyze a ticker when the database lacks one. Runs a few minutes, saves the verdict to the DB, returns the rating + scoreboard + verdict.",
)
_lookup_past_tool = FunctionTool(
    _lookup_past_analyses, name="lookup_past_analyses",
    description="Query the analysis DATABASE for a ticker's past analyses (ratings + realised outcomes). Try this first; it says 'NOT IN DATABASE' if absent.",
)
_get_stored_tool = FunctionTool(
    _get_stored_analysis, name="get_stored_analysis",
    description="Query the analysis DATABASE for the full stored verdict + weighted scoreboard of a ticker's most recent analysis (the 'why' behind the rating).",
)
_list_recent_tool = FunctionTool(
    _list_recent_analyses, name="list_recent_analyses",
    description="List the most recent analyses across all tickers from the database.",
)

_SYSTEM = """You are Trade Buddy's analyst, embedded in a live dashboard. Answer ONLY from your tools — never invent figures. Every claim must be backed by a tool call, with the actual number and its as-of date.

**Reason first, then act.** Before answering, briefly think through what the question is really asking, what data would settle it, and which of your tools provide that data. Then call those tools (combine several when needed), read the results, and only then write the answer. Don't answer from memory when a tool can give the real figure. If the user attached a file, treat its contents as context for the question.

**How to source data (follow this order):**
1. **Recall the conversation.** If the user refers to something earlier ("that stock", "what you said before"), call `lookup_past_conversations` to retrieve it — each request is stateless, so this is your memory across turns and across the clawbot channel.
2. **Query the analysis DATABASE.** For anything about a company's prior assessment, rating, track record, or the reasoning behind it, call `lookup_past_analyses` and `get_stored_analysis` (per ticker), or `list_recent_analyses`. These read Trade Buddy's own stored analyses.
3. **If the database doesn't have it** (the tool replies "NOT IN DATABASE", or the question needs fresh/raw data the store doesn't hold), fall back to the live analyst data tools below — you have every analyst's skills. Fetch it live rather than giving up.
4. **Commission a full analysis when warranted.** If the user wants a rigorous, fresh verdict on a ticker and the database has none, call `run_full_analysis(ticker)`. This runs the entire analyst team (Analysts → Bull/Bear debate → Judge), takes a few minutes, saves the result to the database, and returns the rating + scoreboard + verdict. Tell the user it will take a few minutes before calling it; afterwards it is retrievable via `get_stored_analysis`.

**Live analyst tools (the full dataset):**
- **Macro**: `get_economic_indicator` ('cpi', 'core_pce', 'fed_funds', '10y_treasury', '10y_2y_spread', 'unemployment', 'vix', 'wti_oil', 'ecb_deposit_rate'), `get_macro_snapshot`.
- **News & sentiment**: `get_global_news` (market-moving + macro headlines), `get_news` (a specific company's headlines), `get_social_sentiment` (StockTwits bull/bear, Finnhub social scores, Google search interest — the retail mood).
- **Fundamentals & financial statements**: `get_fundamentals`, `get_income_statement`, `get_balance_sheet`, `get_cashflow`, `get_sec_filings`.
- **Price & technicals**: `get_stock_data` (OHLCV), then `get_indicators` (rsi, macd, close_50_sma, …).
- **Smart money**: `get_insider_transactions` (SEC Form 4 — CEOs/whales), `get_congress_trading` (House + Senate STOCK Act disclosures).

Combine tools when useful (e.g. "is NVDA a buy?" → check the database for a prior verdict, then fundamentals + income statement + smart money + recent news). Today's date is provided by the environment; pass it as `curr_date`/`end_date` when a tool needs one. If even the live tools return nothing, say the data is unavailable rather than guessing.

**Cite the right source — never conflate.** For **congressional / Capitol Hill / STOCK Act** trades, the authoritative source is `get_congress_trading` (House Clerk + Senate eFD + OGE disclosures); for **corporate insider** trades it is `get_insider_transactions` (SEC Form 4). You DO have these as first-party disclosure feeds — use them. A news headline (`get_news`) is NOT a disclosure record: never present a news story about a politician's or insider's trade as if it were first-party filing data. If you mention a headline, attribute it to the news source; if you cite a trade, cite the disclosure feed it came from.

Be concise and decision-useful: lead with the answer, then the supporting figures with their dates. You do not place trades or run the full multi-agent pipeline — you surface and explain what the data holds.

### Current macro snapshot (cached)
{snapshot}
"""


def prewarm_snapshot() -> None:
    """Warm the macro-snapshot cache (call at server startup, off the request path)."""
    try:
        _cached_snapshot()
    except Exception:  # noqa: BLE001
        pass


def _build_agent(provider: str, model: str, api_key: Optional[str] = None):
    client = create_model_client(model, provider=provider, api_key=api_key)
    agent = AssistantAgent(
        name="macro_analyst",
        model_client=client,
        tools=[
            # Macro
            get_economic_indicator_tool,
            get_macro_snapshot_tool,
            # News & sentiment
            get_global_news_tool,
            get_news_tool,
            _social_sentiment_tool,
            # Fundamentals & financial statements
            get_fundamentals_tool,
            get_income_statement_tool,
            get_balance_sheet_tool,
            get_cashflow_tool,
            get_sec_filings_tool,
            # Price & technicals
            get_stock_data_tool,
            get_indicators_tool,
            # Smart money
            get_insider_transactions_tool,
            get_congress_trading_tool,
            get_institutional_holders_tool,
            # Prior analyses (SQLite database)
            _lookup_past_tool,
            _get_stored_tool,
            _list_recent_tool,
            # Conversation memory + commissioning the analyst team
            _lookup_conversations_tool,
            _run_analysis_tool,
        ],
        system_message=_SYSTEM.format(snapshot=_cached_snapshot()),
        reflect_on_tool_use=True,
        model_client_stream=True,   # emit token chunks so the UI fills in live
        max_tool_iterations=8,      # richer dataset → allow combining several tools
    )
    return client, agent


def _task(message: str, history: Optional[List[dict]]) -> str:
    convo = "\n".join(
        f"{h.get('role', 'user')}: {h.get('content', '')}"
        for h in (history or [])[-8:]
    )
    return (convo + "\n" if convo else "") + f"user: {message}"


async def chat(
    message: str,
    history: Optional[List[dict]] = None,
    provider: str = "deepseek",
    model: str = "deepseek-chat",
    api_key: Optional[str] = None,
) -> str:
    """Run one analyst turn (non-streaming). ``history`` is prior {role, content} turns."""
    client, agent = _build_agent(provider, model, api_key=api_key)
    try:
        result = await agent.run(task=_task(message, history))
        return strip_raw_tool_calls(result.messages[-1].content or "")
    finally:
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass


async def chat_stream(
    message: str,
    history: Optional[List[dict]] = None,
    provider: str = "deepseek",
    model: str = "deepseek-chat",
    api_key: Optional[str] = None,
):
    """Stream one analyst turn as events.

    Yields dicts: ``{type: 'status', text}`` for progress (tool lookups), then a
    final ``{type: 'done', text}`` with the answer. Streaming keeps the HTTP
    connection alive (no idle-timeout drops) and gives immediate feedback so the
    UI never looks frozen while the agent calls tools.
    """
    client, agent = _build_agent(provider, model, api_key=api_key)
    final_text = ""
    # DeepSeek thinking models (deepseek-reasoner and the v4 family) stream their
    # chain-of-thought as reasoning_content, which AutoGen wraps in <think>…</think>
    # *inside the token stream*. If we forwarded those chunks verbatim the
    # reasoning would pollute the answer bubble, so we split them out here into
    # separate `reasoning` events; the answer keeps flowing as `token`. The tags
    # always arrive at chunk boundaries (AutoGen prefixes the first reasoning
    # delta with "<think>" and emits "</think>" as its own chunk), so a simple
    # marker scan is robust without cross-chunk buffering.
    in_think = False

    def _split_think(chunk: str):
        """Yield (kind, text) where kind is 'reasoning' or 'token'."""
        nonlocal in_think
        out = []
        buf = chunk
        while buf:
            if not in_think:
                i = buf.find("<think>")
                if i == -1:
                    out.append(("token", buf)); break
                if i: out.append(("token", buf[:i]))
                buf = buf[i + len("<think>"):]; in_think = True
            else:
                i = buf.find("</think>")
                if i == -1:
                    out.append(("reasoning", buf)); break
                if i: out.append(("reasoning", buf[:i]))
                buf = buf[i + len("</think>"):]; in_think = False
        return out

    try:
        async for ev in agent.run_stream(task=_task(message, history)):
            cls = type(ev).__name__
            if cls == "ModelClientStreamingChunkEvent":
                chunk = getattr(ev, "content", "") or ""
                for kind, text in _split_think(chunk):
                    if text:
                        yield {"type": kind, "text": text}
            elif cls == "ToolCallRequestEvent":
                try:
                    names = ", ".join(c.name for c in ev.content)
                except Exception:  # noqa: BLE001
                    names = "data"
                yield {"type": "status", "text": f"Looking up {names}…"}
            elif cls == "ToolCallExecutionEvent":
                yield {"type": "status", "text": "Reading results…"}
            elif hasattr(ev, "messages"):  # final TaskResult
                msgs = getattr(ev, "messages", [])
                if msgs:
                    final_text = getattr(msgs[-1], "content", "") or final_text
        # Safety net: the final content is normally clean (reasoning lives in the
        # message's thought), but strip any stray <think> block just in case.
        clean = re.sub(r"<think>.*?</think>", "", final_text or "", flags=re.DOTALL)
        clean = re.sub(r"^.*?</think>", "", clean, flags=re.DOTALL) if "</think>" in clean else clean
        yield {"type": "done", "text": strip_raw_tool_calls(clean.strip() or "(no response)")}
    finally:
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass
