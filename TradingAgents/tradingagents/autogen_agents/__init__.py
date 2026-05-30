"""AutoGen 0.4 agents for the redesigned TradingAgents pipeline.

Topology: tool-using **analysts** (market/fundamentals/news/sentiment) →
Tree-of-Thoughts **bull/bear researchers** grounded in backtested win rates →
a single **Judge** that verifies the claims, scores weighted metrics, and emits
the final verdict. The risk team, Portfolio Manager, Trader, and Research
Manager of the old LangGraph pipeline are gone — the Judge is the only verdict.
"""

from .context import RunContext
from .analysts import ANALYST_KEYS, create_analyst, run_analyst, strip_raw_tool_calls
from .researchers import run_bear, run_bull
from .debate import run_debate
from .judge import run_judge

__all__ = [
    "RunContext",
    "ANALYST_KEYS",
    "create_analyst",
    "run_analyst",
    "strip_raw_tool_calls",
    "run_bull",
    "run_bear",
    "run_debate",
    "run_judge",
]
