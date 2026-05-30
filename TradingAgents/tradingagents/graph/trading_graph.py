# TradingAgents/graph/trading_graph.py

import asyncio
import json
import logging
import os
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yfinance as yf

logger = logging.getLogger(__name__)

from tradingagents.agents.utils.agent_utils import get_language_instruction
from tradingagents.agents.utils.memory import TradingMemoryLog
from tradingagents.autogen_agents import RunContext
from tradingagents.autogen_clients import create_model_client
from tradingagents.datastore import AnalysisStore, default_store_path
from tradingagents.dataflows.config import set_config
from tradingagents.dataflows.utils import safe_ticker_component
from tradingagents.default_config import DEFAULT_CONFIG

from .orchestrator import AnalysisResult, run_analysis
from .signal_processing import SignalProcessor

# Concise reflection prompt (ported from the old Reflector) used when a past
# decision's realised outcome becomes available.
_REFLECTION_SYSTEM = (
    "You are a trading analyst reviewing your own past decision now that the "
    "outcome is known. Write exactly 2-4 sentences of plain prose (no bullets, "
    "no headers). Cover: was the directional call correct (cite the alpha)? Which "
    "part of the thesis held or failed? One concrete lesson for next time. Be terse."
)


def _run_async(coro):
    """Run ``coro`` to completion from sync code.

    Uses ``asyncio.run`` normally; if a loop is already running in this thread
    (e.g. called from async code), runs the coroutine in a dedicated thread with
    its own loop so we never raise "loop already running".
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    result: Dict[str, Any] = {}

    def _worker():
        result["value"] = asyncio.run(coro)

    t = threading.Thread(target=_worker)
    t.start()
    t.join()
    return result["value"]


class TradingAgentsGraph:
    """Orchestrates the AutoGen trading-agents pipeline.

    The public surface (``__init__`` args, ``propagate``, ``process_signal``) is
    unchanged from the LangGraph era so ``main.py`` and the CLI keep working; the
    internals are now AutoGen agents driven by :func:`run_analysis`.
    """

    def __init__(
        self,
        selected_analysts=["market", "social", "news", "fundamentals"],
        debug=False,
        config: Dict[str, Any] = None,
        callbacks: Optional[List] = None,
    ):
        self.debug = debug
        self.config = config or DEFAULT_CONFIG
        self.callbacks = callbacks or []
        self.selected_analysts = list(selected_analysts)

        set_config(self.config)

        os.makedirs(self.config["data_cache_dir"], exist_ok=True)
        os.makedirs(self.config["results_dir"], exist_ok=True)

        provider = str(self.config.get("llm_provider", "deepseek")).lower()

        # quick_think -> tool-capable chat model; deep_think -> reasoning model.
        self.chat_client = create_model_client(
            self.config["quick_think_llm"],
            provider=provider,
            base_url=self.config.get("backend_url"),
        )
        self.deep_client = create_model_client(
            self.config["deep_think_llm"],
            provider=provider,
            base_url=self.config.get("backend_url"),
        )

        self.memory_log = TradingMemoryLog(self.config)
        store_path = self.config.get("analysis_store_path") or default_store_path(
            self.config["data_cache_dir"]
        )
        self.store = AnalysisStore(store_path)
        self.signal_processor = SignalProcessor()

        self.curr_state = None
        self.ticker = None
        self.log_states_dict = {}

    # --- outcome resolution (benchmark + returns) ---------------------------

    def _resolve_benchmark(self, ticker: str) -> str:
        explicit = self.config.get("benchmark_ticker")
        if explicit:
            return explicit
        benchmark_map = self.config.get("benchmark_map", {})
        ticker_upper = ticker.upper()
        for suffix, benchmark in benchmark_map.items():
            if suffix and ticker_upper.endswith(suffix.upper()):
                return benchmark
        return benchmark_map.get("", "SPY")

    def _fetch_returns(
        self, ticker: str, trade_date: str, holding_days: int = 5,
        benchmark: str = "SPY",
    ) -> Tuple[Optional[float], Optional[float], Optional[int]]:
        """Raw and alpha return for ticker over holding_days from trade_date."""
        try:
            start = datetime.strptime(trade_date, "%Y-%m-%d")
            end = start + timedelta(days=holding_days + 7)
            end_str = end.strftime("%Y-%m-%d")

            stock = yf.Ticker(ticker).history(start=trade_date, end=end_str)
            bench = yf.Ticker(benchmark).history(start=trade_date, end=end_str)

            if len(stock) < 2 or len(bench) < 2:
                return None, None, None

            actual_days = min(holding_days, len(stock) - 1, len(bench) - 1)
            raw = float(
                (stock["Close"].iloc[actual_days] - stock["Close"].iloc[0])
                / stock["Close"].iloc[0]
            )
            bench_ret = float(
                (bench["Close"].iloc[actual_days] - bench["Close"].iloc[0])
                / bench["Close"].iloc[0]
            )
            return raw, raw - bench_ret, actual_days
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "Could not resolve outcome for %s on %s vs %s (retry next run): %s",
                ticker, trade_date, benchmark, e,
            )
            return None, None, None

    def _generate_reflection(
        self, final_decision: str, raw: float, alpha: float, benchmark: str
    ) -> str:
        """Two-to-four sentence reflection on a resolved decision (AutoGen call)."""
        from autogen_core.models import SystemMessage, UserMessage

        user = (
            f"Raw return: {raw:+.1%}\nAlpha vs {benchmark}: {alpha:+.1%}\n\n"
            f"Final Decision:\n{final_decision}"
        )

        async def _go():
            res = await self.chat_client.create(
                [SystemMessage(content=_REFLECTION_SYSTEM),
                 UserMessage(content=user, source="user")]
            )
            return res.content

        try:
            return _run_async(_go())
        except Exception as e:  # noqa: BLE001
            logger.warning("Reflection generation failed: %s", e)
            return ""

    def _resolve_pending_entries(self, ticker: str) -> None:
        """Resolve markdown memory-log entries for ticker at run start."""
        pending = [
            e for e in self.memory_log.get_pending_entries() if e["ticker"] == ticker
        ]
        if not pending:
            return
        benchmark = self._resolve_benchmark(ticker)
        updates = []
        for entry in pending:
            raw, alpha, days = self._fetch_returns(
                ticker, entry["date"], benchmark=benchmark
            )
            if raw is None:
                continue
            reflection = self._generate_reflection(
                entry.get("decision", ""), raw, alpha, benchmark
            )
            updates.append({
                "ticker": ticker, "trade_date": entry["date"],
                "raw_return": raw, "alpha_return": alpha,
                "holding_days": days, "reflection": reflection,
            })
        if updates:
            self.memory_log.batch_update_with_outcomes(updates)

    def _resolve_pending_store_outcomes(self, ticker: str) -> None:
        """Resolve realised outcomes for prior analyses in the SQLite dataset."""
        pending = self.store.pending_outcomes(ticker)
        if not pending:
            return
        benchmark = self._resolve_benchmark(ticker)
        for entry in pending:
            raw, alpha, days = self._fetch_returns(
                ticker, entry["trade_date"], benchmark=benchmark
            )
            if raw is None:
                continue
            self.store.resolve_outcome(
                entry["id"], raw_return=raw, alpha_return=alpha,
                holding_days=days, benchmark=benchmark,
            )

    # --- main entry point ----------------------------------------------------

    def propagate(self, company_name, trade_date, asset_type: str = "stock", on_event=None):
        """Run the pipeline for ``company_name`` on ``trade_date``.

        Returns ``(final_state_dict, processed_signal)`` exactly like before;
        ``final_state_dict`` now carries the new shape (bull/bear cases, the
        Judge's scoreboard, and the verdict) — see
        :meth:`orchestrator.AnalysisResult.to_state_dict`.

        ``on_event(stage, status)`` is an optional callback the CLI uses to drive
        its live status panel; in ``debug`` mode it defaults to logging.
        """
        self.ticker = company_name

        # Resolve realised outcomes from prior runs before starting.
        self._resolve_pending_entries(company_name)
        self._resolve_pending_store_outcomes(company_name)

        ctx = RunContext(
            ticker=company_name,
            trade_date=str(trade_date),
            asset_type=asset_type,
            config=self.config,
            store=self.store,
            chat_client=self.chat_client,
            deep_client=self.deep_client,
            language_instruction=get_language_instruction(),
            past_context=self.memory_log.get_past_context(company_name),
        )

        if on_event is None and self.debug:
            on_event = self._debug_event
        result: AnalysisResult = _run_async(
            run_analysis(ctx, self.selected_analysts, on_event=on_event)
        )

        final_state = result.to_state_dict()
        self.curr_state = final_state
        self._log_state(trade_date, final_state)

        # Mirror the decision into the markdown memory log (back-compat); the
        # SQLite record was already written by the Judge.
        self.memory_log.store_decision(
            ticker=company_name, trade_date=trade_date,
            final_trade_decision=result.final_trade_decision,
        )

        return final_state, self.process_signal(result.final_trade_decision)

    def _debug_event(self, stage: str, status: str, content: str = None, meta: dict = None) -> None:
        logger.info("[%s] %s", status, stage)
        if self.debug:
            print(f"  [{status}] {stage}")

    def _log_state(self, trade_date, final_state):
        """Persist the run's final state to a JSON file under results_dir."""
        self.log_states_dict[str(trade_date)] = final_state

        safe_ticker = safe_ticker_component(self.ticker)
        directory = (
            Path(self.config["results_dir"]) / safe_ticker / "TradingAgentsStrategy_logs"
        )
        directory.mkdir(parents=True, exist_ok=True)
        log_path = directory / f"full_states_log_{trade_date}.json"
        with open(log_path, "w", encoding="utf-8") as f:
            json.dump(final_state, f, indent=4, default=str)

    def process_signal(self, full_signal):
        """Extract the 5-tier rating from the final verdict markdown."""
        return self.signal_processor.process_signal(full_signal)
