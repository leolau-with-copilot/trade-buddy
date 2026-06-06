"""Shared bridge to run the full multi-agent analyst team and persist results.

Both consumers go through here so there is exactly one code path:

* **Trade Buddy** (``webapp.analyst_chat``) exposes :func:`run_analysis_blocking`
  as a tool, so the chat agent can *commission* a fresh analysis when the
  database has nothing for a ticker.
* **The clawbot transmission path** (``/api/clawbot/analyze``) starts the same
  run as a background job (analyses take minutes — too long to hold an HTTP
  connection) and the caller polls :func:`get_job`.

The pipeline itself (``TradingAgentsGraph.propagate``) already writes every run
to the SQLite ``AnalysisStore`` via the Judge, so "save the result" is automatic;
the summary returned here is the same verdict, surfaced for the caller.
"""

from __future__ import annotations

import datetime as dt
import logging
import threading
import uuid
from typing import Any, Dict, List, Optional

from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.trading_graph import TradingAgentsGraph

logger = logging.getLogger(__name__)

_DEFAULT_ANALYSTS = ["market", "social", "news", "fundamentals", "smart_money"]

# In-memory registry of background analysis jobs (process-local). Keyed by a
# job id handed back to the caller; the durable record lives in the SQLite store.
_JOBS: Dict[str, Dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()


def _build_config(
    *, provider: str = "deepseek", research_depth: int = 3,
    language: str = "English", quick: Optional[str] = None,
    deep: Optional[str] = None,
) -> Dict[str, Any]:
    config = DEFAULT_CONFIG.copy()
    config["llm_provider"] = provider.lower()
    config["max_debate_rounds"] = int(research_depth)
    config["output_language"] = language
    if quick:
        config["quick_think_llm"] = quick
    if deep:
        config["deep_think_llm"] = deep
    return config


def run_analysis_blocking(
    ticker: str,
    date: Optional[str] = None,
    *,
    analysts: Optional[List[str]] = None,
    provider: str = "deepseek",
    research_depth: int = 3,
    language: str = "English",
    asset_type: str = "stock",
) -> Dict[str, Any]:
    """Run the analyst team for ``ticker`` and return a verdict summary.

    Blocks until the pipeline finishes (minutes). The full result — scoreboard,
    cited signals, verdict markdown — is persisted to the analysis store; this
    returns the headline fields plus the verdict text for the caller to relay.
    """
    sym = ticker.strip().upper()
    trade_date = date or dt.date.today().isoformat()
    selected = analysts or _DEFAULT_ANALYSTS
    config = _build_config(
        provider=provider, research_depth=research_depth, language=language
    )
    graph = TradingAgentsGraph(selected, config=config, debug=False)
    final_state, decision = graph.propagate(sym, trade_date, asset_type=asset_type)
    return {
        "ticker": sym,
        "trade_date": trade_date,
        "decision": decision,
        "rating": final_state.get("rating"),
        "weighted_score": final_state.get("weighted_score"),
        "scoreboard": final_state.get("scoreboard", []),
        "verdict_md": final_state.get("judge_verdict_md", ""),
        "analysis_id": final_state.get("analysis_id"),
        "consensus_reached": final_state.get("consensus_reached"),
    }


# --------------------------------------------------------------------------- #
# Background jobs (for the clawbot HTTP path)
# --------------------------------------------------------------------------- #
def start_job(
    ticker: str,
    date: Optional[str] = None,
    **kwargs: Any,
) -> str:
    """Kick off an analysis on a worker thread; return a job id to poll."""
    job_id = uuid.uuid4().hex[:12]
    sym = ticker.strip().upper()
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "job_id": job_id, "ticker": sym, "status": "running",
            "started_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "result": None, "error": None,
        }

    def _worker() -> None:
        try:
            result = run_analysis_blocking(sym, date, **kwargs)
            with _JOBS_LOCK:
                _JOBS[job_id].update(status="done", result=result)
        except Exception as exc:  # noqa: BLE001 - report to the poller
            logger.exception("clawbot analysis job %s failed", job_id)
            with _JOBS_LOCK:
                _JOBS[job_id].update(status="error", error=str(exc))

    threading.Thread(target=_worker, name=f"analysis-{job_id}", daemon=True).start()
    return job_id


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    """Current state of a background analysis job, or None if unknown."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        return dict(job) if job else None
