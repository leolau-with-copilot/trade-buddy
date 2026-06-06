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

ANALYST_KEYS = ("market", "fundamentals", "news", "social", "smart_money", "macro")

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
    "smart_money": "smart_money_report",
    "macro": "macro_report",
}

DISPLAY_NAME = {
    "market": "Market Analyst",
    "fundamentals": "Fundamentals Analyst",
    "news": "News Analyst",
    "social": "Sentiment Analyst",
    "smart_money": "Smart-Money Analyst",
    "macro": "Macro Analyst",
}


_MARKET_MSG = """You are a trading assistant analyzing financial markets. Select up to **8** complementary technical indicators (no redundancy) appropriate to the market context, from: close_50_sma, close_200_sma, close_10_ema, macd, macds, macdh, rsi, boll, boll_ub, boll_lb, atr, vwma.

Call `get_stock_data` first to load the price CSV, then `get_indicators` once per indicator using the exact names above. Write a detailed, nuanced report of the trends you observe with specific, actionable insights. Append a Markdown summary table at the end.

**CRITICAL — data integrity rules you must follow:**
1. Only cite prices and indicator values that appear verbatim in the tool results. Never estimate, interpolate, or invent numbers.
2. If the tool returns "N/A" or no row for the analysis date (e.g. market not yet closed, public holiday), state the most-recent date for which data IS available and use that date's values. Label them explicitly, e.g. "as of 2026-05-29 (most recent available)".
3. Never present a prior day's value as today's value. Never fabricate a close price."""

_SMART_MONEY_MSG = """You are a "smart money" flow analyst. Your job is to read what informed, well-resourced actors are doing in this stock and turn it into a directional signal. Use your tools:
- `get_insider_transactions` — corporate insiders via SEC Form 4 (officers/directors and 10%-owner "whales"). Cluster buying by multiple insiders is a strong bullish tell; routine scheduled/option-driven sales are weak signals. Distinguish open-market purchases from sales.
- `get_congress_trading` — U.S. House & Senate (and senior executive-branch) disclosed trades from STOCK Act filings. Note the direction, the size range, whether a filing was LATE, and that disclosures lag the trade by up to ~45 days.

Synthesize across both: where do corporate insiders and politicians agree or diverge? Weight conviction by who is acting, how many, how recently, and how large. Be explicit about data gaps (a feed may be empty or unavailable — say so rather than inventing activity). Never fabricate names, amounts, or dates: cite only what the tools return. Give an overall smart-money read (Accumulation / Distribution / Mixed / Neutral) with a confidence note, then a source-by-source breakdown, and append a Markdown summary table at the end."""

_FUNDAMENTALS_MSG = """You are a researcher analyzing a company's fundamentals. Write a comprehensive report covering financial documents, company profile, basic financials, and financial history. Use `get_fundamentals` for the overview and `get_balance_sheet`, `get_cashflow`, `get_income_statement` for statements. For US-listed companies, use `get_sec_filings` to cite primary-source SEC filings (10-K annual, 10-Q quarterly, 8-K material events) — link the actual documents when relevant. Provide specific, actionable insights and append a Markdown summary table at the end."""


def _news_msg(asset_label: str) -> str:
    return (
        f"You are a company news researcher. Focus on the {asset_label}'s own recent "
        f"news over the past week: earnings and guidance, product/launch and contract "
        f"news, management or governance changes, M&A, legal/regulatory actions, "
        f"analyst rating changes, and sector/peer headlines that move this specific "
        f"name. Use `get_news` for {asset_label}-specific headlines; you may use "
        f"`get_global_news` ONLY for a market event that directly bears on this "
        f"company (e.g. a sector-wide shock). Do NOT analyze the macro backdrop "
        f"(rates, inflation, growth, labor, policy) — a dedicated Macro analyst owns "
        f"that; stay company-specific. Identify concrete catalysts and risks with "
        f"dates and sources, and append a Markdown summary table of the key items at "
        f"the end."
    )


_MACRO_MSG = """You are a macro data collector. Your job is to assemble the macro-economic backdrop as **evidence** for the researchers and judge — collect and present the data clearly; do NOT issue a buy/sell call on the stock. Use your tools:
- `get_macro_snapshot` for a one-call read of the key basket (policy rates, inflation, growth, labor, risk).
- `get_economic_indicator` to pull specific FRED series when you need detail or a trend (e.g. 'fed_funds', 'cpi', 'core_pce', 'unemployment', '10y_treasury', '10y_2y_spread', 'vix', 'wti_oil', 'ecb_deposit_rate').
- `get_global_news` for the macro/world news flow and central-bank/geopolitical headlines.
Report the current level, recent direction (rising/falling/stable), and any notable surprises for each area: monetary policy & rates, inflation, growth, labor, and market-risk gauges. Be explicit about as-of dates and data gaps (say so rather than inventing figures); never fabricate numbers. Append a Markdown summary table of the key indicators (indicator · latest value · trend) at the end. Present the facts — leave the directional interpretation to the bull, bear, and judge."""


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
    elif key == "smart_money":
        system = f"{_SMART_MONEY_MSG}\n\n{header}"
    elif key == "macro":
        system = f"{_MACRO_MSG}\n\n{header}"
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
    """Sentiment analyst: pre-fetch news + StockTwits + Finnhub + Google Trends."""
    from tradingagents.dataflows.stocktwits import fetch_stocktwits_messages
    from tradingagents.dataflows.finnlp_sources import (
        get_finnhub_sentiment,
        get_google_trends,
    )

    ticker = ctx.ticker
    end_date = ctx.trade_date
    start_date = _seven_days_back(end_date)
    news_block = get_news(ticker, start_date, end_date)
    stocktwits_block = fetch_stocktwits_messages(ticker, limit=30)
    finnhub_block = get_finnhub_sentiment(ticker, start_date, end_date)
    trends_block = get_google_trends(ticker, start_date, end_date)

    return f"""You are a financial market sentiment analyst. Produce a comprehensive sentiment report for {ticker} covering {start_date} to {end_date}, drawing on the pre-fetched sources below.

### News headlines — Yahoo Finance, past 7 days
<start_of_news>
{news_block}
<end_of_news>

### StockTwits messages — retail traders, with Bullish/Bearish tags
<start_of_stocktwits>
{stocktwits_block}
<end_of_stocktwits>

### Finnhub social sentiment — Reddit/Twitter mentions & scores
<start_of_finnhub>
{finnhub_block}
<end_of_finnhub>

### Google search interest — retail attention trend
<start_of_trends>
{trends_block}
<end_of_trends>

Read the StockTwits bull/bear ratio and Finnhub mention scores as leading retail signals (mind sample size), use Google search interest as an attention proxy (rising interest often precedes volatility), look for cross-source divergences between news and retail chatter, distinguish opinion from event, surface recurring narratives, and flag data-quality caveats (some sources may be unavailable). Output: overall sentiment direction (Bullish/Bearish/Neutral/Mixed) with a confidence note, a source-by-source breakdown with evidence, divergences/narratives, catalysts and risks, and a Markdown summary table.

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
