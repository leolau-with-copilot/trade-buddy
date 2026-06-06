"""Per-run context shared across the AutoGen agents.

Carries everything an agent factory needs that is fixed for one analysis run:
the instrument, the date, the model clients, the dataset store, and config.
Agents are built per ``propagate()`` call (cheap), so baking run specifics into
each agent's system message keeps prompts grounded without threading state
through a graph the way the old LangGraph pipeline did.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from tradingagents.datastore import AnalysisStore


@dataclass
class RunContext:
    """Immutable-ish context for a single analysis run."""

    ticker: str
    trade_date: str
    asset_type: str
    config: Dict[str, Any]
    store: AnalysisStore
    # Model clients (autogen_ext OpenAIChatCompletionClient instances).
    chat_client: Any   # tool-capable (deepseek-chat)
    deep_client: Any   # reasoning (deepseek-reasoner)
    language_instruction: str = ""
    past_context: str = ""

    @property
    def winrate_horizon_days(self) -> int:
        return int(self.config.get("winrate_horizon_days", 5))

    @property
    def winrate_lookback_years(self) -> int:
        return int(self.config.get("winrate_lookback_years", 3))
