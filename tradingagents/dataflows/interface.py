from typing import Annotated

# Import from vendor-specific modules
from .y_finance import (
    get_YFin_data_online,
    get_stock_stats_indicators_window,
    get_fundamentals as get_yfinance_fundamentals,
    get_balance_sheet as get_yfinance_balance_sheet,
    get_cashflow as get_yfinance_cashflow,
    get_income_statement as get_yfinance_income_statement,
    get_insider_transactions as get_yfinance_insider_transactions,
    get_institutional_holders as get_yfinance_institutional_holders,
)
from .yfinance_news import get_news_yfinance, get_global_news_yfinance
from .akshare_utils import (
    get_akshare_data_online,
    get_stock_stats_indicators_window_akshare,
    is_china_a_share,
)
from . import macro_utils
from . import finnlp_sources
from . import openinsider_utils
from . import congress_kadoa_utils
from . import finviz_utils
from .sec_utils import get_sec_filings

# Configuration and routing logic
from .config import get_config

# Tools organized by category
TOOLS_CATEGORIES = {
    "core_stock_apis": {
        "description": "OHLCV stock price data",
        "tools": [
            "get_stock_data"
        ]
    },
    "technical_indicators": {
        "description": "Technical analysis indicators",
        "tools": [
            "get_indicators"
        ]
    },
    "fundamental_data": {
        "description": "Company fundamentals",
        "tools": [
            "get_fundamentals",
            "get_balance_sheet",
            "get_cashflow",
            "get_income_statement"
        ]
    },
    "news_data": {
        "description": "News data",
        "tools": [
            "get_news",
            "get_global_news",
        ]
    },
    "smart_money": {
        "description": "Corporate insider (Form 4), congressional, and institutional 13F 'smart money' flow",
        "tools": [
            "get_insider_transactions",
            "get_congress_trading",
            "get_institutional_holders",
        ]
    },
    "macro_data": {
        "description": "Macro-economic indicators (rates, inflation, growth, labor)",
        "tools": [
            "get_economic_indicator",
            "get_macro_snapshot",
        ]
    },
    "filings": {
        "description": "Primary-source regulatory filings",
        "tools": [
            "get_sec_filings",
        ]
    },
}

VENDOR_LIST = [
    "yfinance",
    "akshare",
    "finnhub",
    "finviz",
    "openinsider",
    "kadoa",
]

# Mapping of methods to their vendor-specific implementations
VENDOR_METHODS = {
    # core_stock_apis
    "get_stock_data": {
        "yfinance": get_YFin_data_online,
        "akshare": get_akshare_data_online,
    },
    # technical_indicators
    "get_indicators": {
        "yfinance": get_stock_stats_indicators_window,
        "akshare": get_stock_stats_indicators_window_akshare,
    },
    # fundamental_data
    "get_fundamentals": {
        "yfinance": get_yfinance_fundamentals,
    },
    "get_balance_sheet": {
        "yfinance": get_yfinance_balance_sheet,
    },
    "get_cashflow": {
        "yfinance": get_yfinance_cashflow,
    },
    "get_income_statement": {
        "yfinance": get_yfinance_income_statement,
    },
    # news_data
    "get_news": {
        "yfinance": get_news_yfinance,
        "finnhub": finnlp_sources.get_finnhub_news,
        "finviz": finviz_utils.get_finviz_news,
    },
    "get_global_news": {
        "yfinance": get_global_news_yfinance,
        "akshare": finnlp_sources.get_cctv_news,
        "finviz": finviz_utils.get_finviz_global_news,
    },
    # smart_money — corporate insiders via OpenInsider (SEC Form 4) with Finnhub
    # (JSON) then yfinance as fallbacks; congressional via the Kadoa open STOCK
    # Act dataset.
    "get_insider_transactions": {
        "openinsider": openinsider_utils.get_insider_transactions,
        "finnhub": finnlp_sources.get_finnhub_insider,
        "yfinance": get_yfinance_insider_transactions,
    },
    "get_congress_trading": {
        "kadoa": congress_kadoa_utils.get_congress_trading,
    },
    "get_institutional_holders": {
        "yfinance": get_yfinance_institutional_holders,
    },
    # macro_data
    "get_economic_indicator": {
        "fred": macro_utils.get_economic_indicator,
    },
    "get_macro_snapshot": {
        "fred": macro_utils.get_macro_snapshot,
    },
    # filings
    "get_sec_filings": {
        "sec": get_sec_filings,
    },
}

def get_category_for_method(method: str) -> str:
    """Get the category that contains the specified method."""
    for category, info in TOOLS_CATEGORIES.items():
        if method in info["tools"]:
            return category
    raise ValueError(f"Method '{method}' not found in any category")

def get_vendor(category: str, method: str = None) -> str:
    """Get the configured vendor for a data category or specific tool method.
    Tool-level configuration takes precedence over category-level.
    """
    config = get_config()

    # Check tool-level configuration first (if method provided)
    if method:
        tool_vendors = config.get("tool_vendors", {})
        if method in tool_vendors:
            return tool_vendors[method]

    # Fall back to category-level configuration
    return config.get("data_vendors", {}).get(category, "default")

# Methods that operate on a ticker symbol passed as the first positional arg.
# For these, a mainland-China A-share symbol is auto-routed to AKShare ahead of
# the configured vendor, since yfinance is unreliable for those listings.
_SYMBOL_FIRST_METHODS = {"get_stock_data", "get_indicators"}


def _auto_vendor_override(method: str, args: tuple) -> list:
    """Return vendors to try first based on the symbol, before configured ones.

    Currently: China A-share symbols → AKShare. Returns an empty list when no
    override applies (the normal configured routing then takes over).
    """
    if method in _SYMBOL_FIRST_METHODS and args:
        symbol = args[0]
        if isinstance(symbol, str) and is_china_a_share(symbol):
            return ["akshare"]
    return []


def route_to_vendor(method: str, *args, **kwargs):
    """Route method calls to appropriate vendor implementation with fallback support."""
    category = get_category_for_method(method)
    vendor_config = get_vendor(category, method)
    primary_vendors = [v.strip() for v in vendor_config.split(',')]

    if method not in VENDOR_METHODS:
        raise ValueError(f"Method '{method}' not supported")

    # Symbol-driven override (e.g. China A-shares → AKShare) takes priority over
    # the configured vendor, then the configured vendors, then the rest.
    primary_vendors = _auto_vendor_override(method, args) + primary_vendors

    # Build fallback chain: primary vendors first, then remaining available vendors
    all_available_vendors = list(VENDOR_METHODS[method].keys())
    fallback_vendors = primary_vendors.copy()
    for vendor in all_available_vendors:
        if vendor not in fallback_vendors:
            fallback_vendors.append(vendor)

    last_error = None
    for vendor in fallback_vendors:
        if vendor not in VENDOR_METHODS[method]:
            continue

        vendor_impl = VENDOR_METHODS[method][vendor]
        impl_func = vendor_impl[0] if isinstance(vendor_impl, list) else vendor_impl

        # A vendor that raises (e.g. a missing key, a blocked endpoint, or a network error)
        # shouldn't abort the run — fall through to the next vendor and only
        # surface an error if every candidate fails.
        try:
            return impl_func(*args, **kwargs)
        except Exception as e:  # noqa: BLE001 — deliberate cross-vendor fallback
            last_error = e
            import logging
            logging.getLogger(__name__).warning(
                "Vendor '%s' failed for '%s' (%s); trying next vendor.",
                vendor, method, e,
            )

    if last_error is not None:
        raise RuntimeError(
            f"All vendors failed for '{method}'; last error: {last_error}"
        ) from last_error
    raise RuntimeError(f"No available vendor for '{method}'")