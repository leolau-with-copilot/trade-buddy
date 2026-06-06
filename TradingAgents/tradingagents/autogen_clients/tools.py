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
    """Retrieve recent corporate insider (SEC Form 4) transactions for ``ticker``.

    Officer/director and 10%-owner ('whale') open-market buys and sells, via
    OpenInsider. Cluster buying by several insiders is a strong bullish tell.
    """
    return route_to_vendor("get_insider_transactions", ticker)


def get_institutional_holders(ticker: str) -> str:
    """Institutional 13F ('whale') holders and ownership breakdown for a ticker."""
    return route_to_vendor("get_institutional_holders", ticker)


def get_congress_trading(ticker: str) -> str:
    """Retrieve disclosed U.S. House + Senate (congressional) trades in ``ticker``.

    A slow, directional 'smart money' signal from STOCK Act disclosures:
    politicians' personal trades, reported as amount ranges and disclosed up to
    ~45 days after the trade.
    """
    return route_to_vendor("get_congress_trading", ticker)


def get_economic_indicator(
    indicator: str, start_date: str = "", end_date: str = ""
) -> str:
    """Retrieve a macro-economic time series (FRED).

    ``indicator`` is a friendly alias (e.g. 'unemployment', 'cpi', 'core_pce',
    'fed_funds', '10y_treasury', '10y_2y_spread', 'vix', 'wti_oil',
    'ecb_deposit_rate') or a raw FRED series id. Returns the latest value, the
    period change, and a short recent history.
    """
    return route_to_vendor("get_economic_indicator", indicator, start_date, end_date)


def get_macro_snapshot(curr_date: str = "") -> str:
    """Retrieve a one-call snapshot of the key macro basket (rates, inflation,
    growth, labor, risk) — a fast macro backdrop as of ``curr_date``."""
    return route_to_vendor("get_macro_snapshot", curr_date)


def get_sec_filings(ticker: str, form_type: str = "", limit: int = 20) -> str:
    """Retrieve recent SEC EDGAR filings for a US-listed ``ticker``.

    Optionally filter by ``form_type`` ('10-K', '10-Q', '8-K', …). Each entry
    includes the form, filing/report dates, and a direct primary-document URL.
    """
    return route_to_vendor("get_sec_filings", ticker, form_type, limit)


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
    get_insider_transactions, "Get corporate insider (SEC Form 4) transactions for a ticker."
)
get_congress_trading_tool = _tool(
    get_congress_trading, "Get U.S. congressional (House + Senate) trades in a ticker."
)
get_institutional_holders_tool = _tool(
    get_institutional_holders,
    "Get institutional 13F ('whale') holders and ownership breakdown for a ticker.",
)
get_economic_indicator_tool = _tool(
    get_economic_indicator, "Get a macro-economic indicator time series (FRED)."
)
get_macro_snapshot_tool = _tool(
    get_macro_snapshot, "Get a one-call snapshot of key macro indicators."
)
get_sec_filings_tool = _tool(
    get_sec_filings, "Get recent SEC EDGAR filings for a US-listed ticker."
)


def analyst_tools(analyst_key: str) -> List[FunctionTool]:
    """Return the FunctionTools for an analyst type.

    Mirrors the per-analyst tool sets the old LangGraph ``ToolNode`` wiring used
    (see ``graph/trading_graph.py::_create_tool_nodes``).
    """
    mapping = {
        "market": [get_stock_data_tool, get_indicators_tool],
        "social": [get_news_tool],
        "news": [
            get_news_tool,
            get_global_news_tool,
        ],
        "fundamentals": [
            get_fundamentals_tool,
            get_balance_sheet_tool,
            get_cashflow_tool,
            get_income_statement_tool,
            get_sec_filings_tool,
            get_institutional_holders_tool,
        ],
        "smart_money": [
            get_insider_transactions_tool,
            get_congress_trading_tool,
            get_institutional_holders_tool,
        ],
        "macro": [
            get_macro_snapshot_tool,
            get_economic_indicator_tool,
            get_global_news_tool,
        ],
    }
    return mapping[analyst_key]
