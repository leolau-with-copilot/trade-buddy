"""AutoGen analyst agents: market/technical, fundamentals, news, sentiment.

Each analyst is an :class:`~autogen_agentchat.agents.AssistantAgent` on the
tool-capable ``deepseek-chat`` client. The tool-using analysts (market,
fundamentals, news) loop over their FunctionTools until they produce a report;
the sentiment analyst pre-fetches its three data sources and writes the report in
a single turn (no tool calls), exactly as the old LangGraph version did.

Prompts are ported from the previous ``agents/analysts/*`` modules.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import List

from autogen_agentchat.agents import AssistantAgent

from tradingagents.agents.utils.agent_utils import build_instrument_context
from tradingagents.autogen_clients.tools import analyst_tools, get_news
from .context import RunContext

ANALYST_KEYS = ("market", "fundamentals", "news", "social")

# Compiled patterns for non-standard tool-call formats that some LLMs (e.g.
# Gemma via OpenRouter) emit as plain text because they don't use the standard
# OpenAI function-calling API.  These tokens must be stripped from report
# content before it is displayed or stored — they are never valid markdown.
_TOOL_CALL_PATTERNS = re.compile(
    r"<\|tool_call\|?>.*?<\|/tool_call\|?>|"   # Gemma: <|tool_call|>...</|tool_call|>
    r"<\|tool_call>.*?<tool_call\|>|"            # Gemma alt: <|tool_call>...</tool_call|>
    r"<tool_call>.*?</tool_call>|"               # generic XML-style
    r"\[TOOL_CALL\].*?\[/TOOL_CALL\]",           # bracket-style
    re.DOTALL | re.IGNORECASE,
)


def strip_raw_tool_calls(text: str) -> str:
    """Remove non-standard tool-call markup that some LLMs embed in plain text."""
    return _TOOL_CALL_PATTERNS.sub("", text).strip()

# Report field each analyst populates in the shared result.
REPORT_FIELD = {
    "market": "market_report",
    "fundamentals": "fundamentals_report",
    "news": "news_report",
    "social": "sentiment_report",
}

DISPLAY_NAME = {
    "market": "Market Analyst",
    "fundamentals": "Fundamentals Analyst",
    "news": "News Analyst",
    "social": "Sentiment Analyst",
}


_MARKET_MSG = """You are a trading assistant analyzing financial markets. Select up to **8** complementary technical indicators (no redundancy) appropriate to the market context, from: close_50_sma, close_200_sma, close_10_ema, macd, macds, macdh, rsi, boll, boll_ub, boll_lb, atr, vwma.

Call `get_stock_data` first to load the price CSV, then `get_indicators` once per indicator using the exact names above. Write a detailed, nuanced report of the trends you observe with specific, actionable insights. Append a Markdown summary table at the end.

**CRITICAL — data integrity rules you must follow:**
1. Only cite prices and indicator values that appear verbatim in the tool results. Never estimate, interpolate, or invent numbers.
2. If the tool returns "N/A" or no row for the analysis date (e.g. market not yet closed, public holiday), state the most-recent date for which data IS available and use that date's values. Label them explicitly, e.g. "as of 2026-05-29 (most recent available)".
3. Never present a prior day's value as today's value. Never fabricate a close price."""

_FUNDAMENTALS_MSG = """You are a researcher analyzing a company's fundamentals. Write a comprehensive report covering financial documents, company profile, basic financials, and financial history. Use `get_fundamentals` for the overview and `get_balance_sheet`, `get_cashflow`, `get_income_statement` for statements. Provide specific, actionable insights and append a Markdown summary table at the end."""


def _news_msg(asset_label: str) -> str:
    return (
        f"You are a news researcher analyzing recent news and macro trends over the "
        f"past week. Write a comprehensive report of the world state relevant for "
        f"trading. Use `get_news` for {asset_label}-specific news and `get_global_news` "
        f"for macro news. Provide actionable insights and append a Markdown summary "
        f"table at the end."
    )


def _common_header(ctx: RunContext) -> str:
    instrument = build_instrument_context(ctx.ticker, ctx.asset_type)
    return (
        f"For your reference, the current date is {ctx.trade_date}. {instrument}"
        f"{ctx.language_instruction}"
    )


def create_analyst(key: str, ctx: RunContext) -> AssistantAgent:
    """Build the AutoGen AssistantAgent for analyst ``key``.

    The sentiment ("social") analyst is handled by :func:`run_analyst` because it
    pre-fetches data into its prompt and uses no tools.
    """
    header = _common_header(ctx)
    if key == "market":
        system = f"{_MARKET_MSG}\n\n{header}"
    elif key == "fundamentals":
        system = f"{_FUNDAMENTALS_MSG}\n\n{header}"
    elif key == "news":
        asset_label = "company" if ctx.asset_type == "stock" else "asset"
        system = f"{_news_msg(asset_label)}\n\n{header}"
    else:
        raise ValueError(f"create_analyst does not build '{key}' (use run_analyst)")

    return AssistantAgent(
        name=key + "_analyst",
        model_client=ctx.chat_client,
        tools=list(analyst_tools(key)),
        system_message=system,
        reflect_on_tool_use=True,
        max_tool_iterations=8,
    )


def _seven_days_back(trade_date: str) -> str:
    return (datetime.strptime(trade_date, "%Y-%m-%d") - timedelta(days=7)).strftime("%Y-%m-%d")


def _sentiment_system_message(ctx: RunContext) -> str:
    """Sentiment analyst: pre-fetch news + StockTwits + Reddit into the prompt."""
    from tradingagents.dataflows.reddit import fetch_reddit_posts
    from tradingagents.dataflows.stocktwits import fetch_stocktwits_messages

    ticker = ctx.ticker
    end_date = ctx.trade_date
    start_date = _seven_days_back(end_date)
    news_block = get_news(ticker, start_date, end_date)
    stocktwits_block = fetch_stocktwits_messages(ticker, limit=30)
    reddit_block = fetch_reddit_posts(ticker)

    return f"""You are a financial market sentiment analyst. Produce a comprehensive sentiment report for {ticker} covering {start_date} to {end_date}, drawing on three pre-fetched sources.

### News headlines — Yahoo Finance, past 7 days
<start_of_news>
{news_block}
<end_of_news>

### StockTwits messages — retail traders, with Bullish/Bearish tags
<start_of_stocktwits>
{stocktwits_block}
<end_of_stocktwits>

### Reddit posts — r/wallstreetbets, r/stocks, r/investing
<start_of_reddit>
{reddit_block}
<end_of_reddit>

Read the StockTwits bull/bear ratio as a leading retail signal (mind sample size), look for cross-source divergences, weight Reddit by engagement, distinguish opinion from event, surface recurring narratives, and flag data-quality caveats. Output: overall sentiment direction (Bullish/Bearish/Neutral/Mixed) with a confidence note, a source-by-source breakdown with evidence, divergences/narratives, catalysts and risks, and a Markdown summary table.

For your reference, the current date is {end_date}.{ctx.language_instruction}"""


async def run_analyst(key: str, ctx: RunContext) -> str:
    """Run analyst ``key`` and return its report text."""
    if key == "social":
        agent = AssistantAgent(
            name="sentiment_analyst",
            model_client=ctx.chat_client,
            system_message=_sentiment_system_message(ctx),
        )
        task = f"Write the sentiment report for {ctx.ticker}."
    else:
        agent = create_analyst(key, ctx)
        task = (
            f"Analyze {ctx.ticker} as of {ctx.trade_date} and produce your report. "
            f"Use your tools as needed, then write the final report."
        )

    result = await agent.run(task=task)
    last = result.messages[-1]
    raw = getattr(last, "content", "") or ""
    return strip_raw_tool_calls(raw)
