"""AutoGen 0.4 model clients and tool adapters for TradingAgents.

The only LLM-client layer (the old LangChain/LangGraph stack has been removed).
Supports three OpenAI-compatible providers — DeepSeek, OpenRouter, and Ollama —
through :class:`autogen_ext.models.openai.OpenAIChatCompletionClient`.
"""

from .model_client import (
    DEEPSEEK_BASE_URL,
    PROVIDER_API_KEY_ENV,
    SUPPORTED_PROVIDERS,
    create_model_client,
    is_tool_calling_model,
)
from .tools import (
    analyst_tools,
    get_balance_sheet_tool,
    get_cashflow_tool,
    get_fundamentals_tool,
    get_global_news_tool,
    get_income_statement_tool,
    get_indicators_tool,
    get_insider_transactions_tool,
    get_news_tool,
    get_stock_data_tool,
)

__all__ = [
    "DEEPSEEK_BASE_URL",
    "PROVIDER_API_KEY_ENV",
    "SUPPORTED_PROVIDERS",
    "create_model_client",
    "is_tool_calling_model",
    "analyst_tools",
    "get_stock_data_tool",
    "get_indicators_tool",
    "get_fundamentals_tool",
    "get_balance_sheet_tool",
    "get_cashflow_tool",
    "get_income_statement_tool",
    "get_news_tool",
    "get_global_news_tool",
    "get_insider_transactions_tool",
]
