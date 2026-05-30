"""FastAPI backend for the TradingAgents web UI.

Endpoints
---------
* ``GET /api/search?q=``        — ticker autocomplete (Yahoo), case-insensitive.
* ``GET /api/prices?ticker=&range=`` — historical closes for the price chart.
* ``GET /api/analyze`` (SSE)    — run the pipeline, stream live events.
* ``GET /``                     — the single-page app.

The pipeline (``TradingAgentsGraph.propagate``) is blocking and drives a
``on_event(stage, status, content)`` callback. We run it on a worker thread and
bridge each callback into an ``asyncio.Queue`` (via ``call_soon_threadsafe``) that
the SSE generator drains — so the browser sees status/flow/report events live.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.trading_graph import TradingAgentsGraph

logger = logging.getLogger(__name__)

_STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Trade Buddy Web")

# range -> (yfinance period, interval)
# 3m fetches 1h then resamples to 2h (yfinance has no 2h interval)
# 1d fetches today's 1-min bars; falls back to most recent trading day if empty
_RANGES = {
    "1d":  ("1d",  "1m"),
    "5d":  ("5d",  "5m"),
    "1w":  ("7d",  "15m"),
    "1m":  ("1mo", "1h"),
    "3m":  ("3mo", "1h"),
    "6m":  ("6mo", "1d"),
    "ytd": ("ytd", "1d"),
    "1y":  ("1y",  "1d"),
    "5y":  ("5y",  "1wk"),
    "max": ("max", "1mo"),
}

# Fixed pipeline topology for the frontend's animated flow graph: which agent's
# output flows to which next agent(s).
_FLOW_EDGES = {
    "Market Analyst": ["Bull Researcher", "Bear Researcher"],
    "Fundamentals Analyst": ["Bull Researcher", "Bear Researcher"],
    "News Analyst": ["Bull Researcher", "Bear Researcher"],
    "Sentiment Analyst": ["Bull Researcher", "Bear Researcher"],
    "Bull Researcher": ["Judge"],
    "Bear Researcher": ["Judge"],
    "Judge": [],
}


# --------------------------------------------------------------------------- #
# Ticker search
# --------------------------------------------------------------------------- #
@app.get("/api/search")
def search(q: str = Query(..., min_length=1)) -> List[Dict[str, str]]:
    """Autocomplete tickers by name or symbol (Yahoo Finance), case-insensitive."""
    try:
        resp = requests.get(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": q, "quotesCount": 8, "newsCount": 0},
            headers={"User-Agent": "Mozilla/5.0 (TradingAgents)"},
            timeout=8,
        )
        resp.raise_for_status()
        quotes = resp.json().get("quotes", [])
    except Exception as exc:  # noqa: BLE001
        logger.warning("ticker search failed for %r: %s", q, exc)
        return []

    out = []
    for item in quotes:
        symbol = item.get("symbol")
        if not symbol:
            continue
        out.append({
            "symbol": symbol,
            "name": item.get("shortname") or item.get("longname") or "",
            "exchange": item.get("exchDisp") or item.get("exchange") or "",
            "type": item.get("quoteType") or "",
        })
    return out


# --------------------------------------------------------------------------- #
# Price history
# --------------------------------------------------------------------------- #
@app.get("/api/prices")
def prices(ticker: str = Query(...), range: str = Query("3m")) -> Dict[str, Any]:
    """Return OHLCV candles for ``ticker`` over a named range."""
    period, interval = _RANGES.get(range, _RANGES["3m"])
    tk = yf.Ticker(ticker)
    try:
        hist = tk.history(period=period, interval=interval)

        # 1D: today's 1-min bars; fall back to most recent trading day when empty
        if range == "1d" and hist.empty:
            hist = tk.history(period="5d", interval="1m")
            if not hist.empty:
                last_date = hist.index.to_series().dt.date.iloc[-1]
                hist = hist[hist.index.to_series().dt.date == last_date]

        # 3M: yfinance has no 2h interval — aggregate 1h bars into 2h bars
        if range == "3m" and not hist.empty:
            hist = (
                hist.resample("2h")
                .agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"})
                .dropna(subset=["Close"])
            )

    except Exception as exc:  # noqa: BLE001
        return {"ticker": ticker, "range": range, "candles": [], "error": str(exc)}

    if hist.empty:
        return {"ticker": ticker, "range": range, "candles": []}

    hist = hist.dropna(subset=["Close"])

    def _ts(idx) -> int:
        return int(idx.timestamp() * 1000)

    candles = [
        {
            "t": _ts(idx),
            "o": round(float(row["Open"]), 4),
            "h": round(float(row["High"]), 4),
            "l": round(float(row["Low"]), 4),
            "c": round(float(row["Close"]), 4),
            "v": int(row["Volume"]),
        }
        for idx, row in hist.iterrows()
    ]

    last = candles[-1]["c"] if candles else None
    first = candles[0]["c"] if candles else None
    change_pct = ((last - first) / first * 100.0) if (first and last) else None

    return {
        "ticker": ticker,
        "range": range,
        "last": last,
        "change_pct": change_pct,
        "candles": candles,
    }


# --------------------------------------------------------------------------- #
# Analysis stream (SSE)
# --------------------------------------------------------------------------- #
def _summarize(text: str, limit: int = 90) -> str:
    """A short topic label for the flowing-message animation."""
    if not text:
        return ""
    for line in text.splitlines():
        s = line.strip().lstrip("#*->•").strip()
        # Prefer a rating line for the judge.
        if s.lower().startswith("**rating**") or s.lower().startswith("rating"):
            return s.replace("*", "")[:limit]
        if len(s) > 4:
            return (s[:limit] + "…") if len(s) > limit else s
    return text.strip()[:limit]


def _sse(event: Dict[str, Any]) -> str:
    return f"data: {json.dumps(event)}\n\n"


@app.get("/api/analyze")
async def analyze(
    ticker: str = Query(...),
    date: Optional[str] = Query(None),
    analysts: str = Query("market,social,news,fundamentals"),
    provider: str = Query("deepseek"),
    quick: Optional[str] = Query(None),
    deep: Optional[str] = Query(None),
    backend_url: Optional[str] = Query(None),
    research_depth: int = Query(3, ge=1, le=5),
    language: str = Query("English"),
):
    """Run the pipeline and stream live events as Server-Sent Events."""
    trade_date = date or dt.date.today().isoformat()
    selected = [a.strip() for a in analysts.split(",") if a.strip()]

    config = DEFAULT_CONFIG.copy()
    config["llm_provider"] = provider.lower()
    config["max_debate_rounds"] = research_depth
    config["output_language"] = language
    if quick:
        config["quick_think_llm"] = quick
    if deep:
        config["deep_think_llm"] = deep
    if backend_url:
        config["backend_url"] = backend_url

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def emit(event: Dict[str, Any]) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    def on_event(stage: str, status: str, content: Optional[str] = None,
                 meta: Optional[Dict[str, Any]] = None) -> None:
        meta = meta or {}
        if status == "usage":
            emit({"type": "usage", "tokens_in": meta.get("tokens_in", 0),
                  "tokens_out": meta.get("tokens_out", 0)})
            return
        if status == "debate":
            emit({"type": "debate", "side": meta.get("side"),
                  "round": meta.get("round"), "rounds": meta.get("rounds"),
                  "summary": meta.get("summary", ""), "content": content or ""})
            return
        if status == "consensus":
            emit({"type": "consensus",
                  "consensus_reached": bool(meta.get("consensus_reached")),
                  "sub_points": meta.get("sub_points", []),
                  "remaining_disagreements": meta.get("remaining_disagreements", []),
                  "content": content or ""})
            return
        emit({"type": "status", "agent": stage, "status": status})
        if status == "completed" and content:
            emit({
                "type": "report", "agent": stage,
                "summary": _summarize(content), "content": content,
                "flow_to": _FLOW_EDGES.get(stage, []),
            })

    def run() -> None:
        try:
            graph = TradingAgentsGraph(selected, config=config, debug=False)
            final_state, decision = graph.propagate(
                ticker, trade_date, asset_type="stock", on_event=on_event,
            )
            ti = to = 0
            for client in (graph.chat_client, graph.deep_client):
                try:
                    usage = client.total_usage()
                    ti += int(getattr(usage, "prompt_tokens", 0) or 0)
                    to += int(getattr(usage, "completion_tokens", 0) or 0)
                except Exception:  # noqa: BLE001
                    pass
            emit({
                "type": "done", "decision": decision,
                "rating": final_state.get("rating"),
                "weighted_score": final_state.get("weighted_score"),
                "scoreboard": final_state.get("scoreboard", []),
                "verdict_md": final_state.get("judge_verdict_md", ""),
                "tokens_in": ti, "tokens_out": to,
            })
        except Exception as exc:  # noqa: BLE001 - surface to the browser
            logger.exception("analysis failed")
            emit({"type": "error", "message": str(exc)})
        finally:
            emit({"type": "_end"})

    async def event_stream():
        emit({"type": "start", "ticker": ticker, "date": trade_date,
              "analysts": selected})
        # Launch the blocking pipeline on a worker thread.
        asyncio.get_running_loop().run_in_executor(None, run)
        while True:
            event = await queue.get()
            if event.get("type") == "_end":
                break
            yield _sse(event)
        yield _sse({"type": "close"})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# --------------------------------------------------------------------------- #
# Static frontend
# --------------------------------------------------------------------------- #
@app.get("/")
def index() -> FileResponse:
    return FileResponse(_STATIC / "index.html")


app.mount("/static", StaticFiles(directory=str(_STATIC)), name="static")
