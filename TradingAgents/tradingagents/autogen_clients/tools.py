"""AutoGen FunctionTool adapters over the existing dataflow layer.

The dataflow layer (``tradingagents.dataflows.interface.route_to_vendor`` and the
vendor implementations behind it) is unchanged. The old LangChain ``@tool``
wrappers in ``agents/utils/*_tools.py`` are replaced here by plain functions wrapped
as :class:`autogen_core.tools.FunctionTool`, which AutoGen agents accept directly.

AutoGen derives each tool's JSON schema from the function signature and the
``description`` argument, so the type hints and docstrings below are what the model
sees when deciding how to call a tool.
"""

from __future__ import annotations

from typing import List, Optional

from autogen_core.tools import FunctionTool

from tradingagents.dataflows.interface import route_to_vendor


# --- raw functions (call the unchanged dataflow router) ---------------------


def get_stock_data(symbol: str, start_date: str, end_date: str) -> str:
    """Retrieve OHLCV stock price data for ``symbol`` between two dates (yyyy-mm-dd).

    Call this before requesting indicators, since indicators are derived from the
    price CSV this returns.
    """
    return route_to_vendor("get_stock_data", symbol, start_date, end_date)


def get_indicators(
    symbol: str, indicator: str, curr_date: str, look_back_days: int = 30
) -> str:
    """Retrieve one technical ``indicator`` (e.g. 'rsi', 'macd', 'close_50_sma') for
    ``symbol`` as of ``curr_date`` (yyyy-mm-dd), looking back ``look_back_days``.

    Use the exact indicator names from the analyst instructions. Call once per
    indicator (a comma-separated string is also tolerated).
    """
    return route_to_vendor("get_indicators", symbol, indicator, curr_date, look_back_days)


def get_fundamentals(ticker: str, curr_date: str) -> str:
    """Retrieve comprehensive fundamental data for ``ticker`` as of ``curr_date``."""
    return route_to_vendor("get_fundamentals", ticker, curr_date)


def get_balance_sheet(
    ticker: str, freq: str = "quarterly", curr_date: Optional[str] = None
) -> str:
    """Retrieve the balance sheet for ``ticker`` (freq: 'annual' or 'quarterly')."""
    return route_to_vendor("get_balance_sheet", ticker, freq, curr_date)


def get_cashflow(
    ticker: str, freq: str = "quarterly", curr_date: Optional[str] = None
) -> str:
    """Retrieve the cash flow statement for ``ticker`` (freq: 'annual'/'quarterly')."""
    return route_to_vendor("get_cashflow", ticker, freq, curr_date)


def get_income_statement(
    ticker: str, freq: str = "quarterly", curr_date: Optional[str] = None
) -> str:
    """Retrieve the income statement for ``ticker`` (freq: 'annual'/'quarterly')."""
    return route_to_vendor("get_income_statement", ticker, freq, curr_date)


def get_news(ticker: str, start_date: str, end_date: str) -> str:
    """Retrieve company/ticker news for ``ticker`` between two dates (yyyy-mm-dd)."""
    return route_to_vendor("get_news", ticker, start_date, end_date)


def get_global_news(
    curr_date: str,
    look_back_days: Optional[int] = None,
    limit: Optional[int] = None,
) -> str:
    """Retrieve global macro/world news as of ``curr_date`` (yyyy-mm-dd).

    Omit ``look_back_days`` / ``limit`` to inherit the configured defaults.
    """
    return route_to_vendor("get_global_news", curr_date, look_back_days, limit)


def get_insider_transactions(ticker: str) -> str:
    """Retrieve recent insider-transaction activity for ``ticker``."""
    return route_to_vendor("get_insider_transactions", ticker)


# --- FunctionTool wrappers ---------------------------------------------------


def _tool(func, description: str) -> FunctionTool:
    return FunctionTool(func, description=description, name=func.__name__)


get_stock_data_tool = _tool(
    get_stock_data, "Get OHLCV price data for a ticker over a date range."
)
get_indicators_tool = _tool(
    get_indicators, "Get a single technical indicator series for a ticker."
)
get_fundamentals_tool = _tool(
    get_fundamentals, "Get comprehensive fundamental data for a ticker."
)
get_balance_sheet_tool = _tool(get_balance_sheet, "Get a ticker's balance sheet.")
get_cashflow_tool = _tool(get_cashflow, "Get a ticker's cash flow statement.")
get_income_statement_tool = _tool(
    get_income_statement, "Get a ticker's income statement."
)
get_news_tool = _tool(get_news, "Get news for a ticker over a date range.")
get_global_news_tool = _tool(get_global_news, "Get global macro/world news.")
get_insider_transactions_tool = _tool(
    get_insider_transactions, "Get insider-transaction activity for a ticker."
)


def analyst_tools(analyst_key: str) -> List[FunctionTool]:
    """Return the FunctionTools for an analyst type.

    Mirrors the per-analyst tool sets the old LangGraph ``ToolNode`` wiring used
    (see ``graph/trading_graph.py::_create_tool_nodes``).
    """
    mapping = {
        "market": [get_stock_data_tool, get_indicators_tool],
        "social": [get_news_tool],
        "news": [get_news_tool, get_global_news_tool, get_insider_transactions_tool],
        "fundamentals": [
            get_fundamentals_tool,
            get_balance_sheet_tool,
            get_cashflow_tool,
            get_income_statement_tool,
        ],
    }
    return mapping[analyst_key]
