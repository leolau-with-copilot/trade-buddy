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
import os
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
import pandas as pd
import yfinance as yf
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.trading_graph import TradingAgentsGraph
from webapp.markets import COUNTRY_EXCHANGES, search_china_all, search_exchange, us_symbol_list
from webapp import analyst_chat, calendar_feed, dashboard, quote as quote_mod, smartmoney as sm_mod, watchlist as wl_mod, whale

logger = logging.getLogger(__name__)


# Some deployments (a backgrounded process, a detached terminal) end up with a
# CLOSED stderr. Python's logging "last resort" handler then raises
# `ValueError: I/O operation on closed file` on every webapp log call — which,
# inside a request handler, turns into a 500 (the backtester hit exactly this).
# Attach a root handler whose error path never raises, so logging can never
# crash a request regardless of stream state.
class _SafeStreamHandler(logging.StreamHandler):
    def handleError(self, record):  # noqa: D401 - never raise (e.g. closed stream)
        pass


if not logging.getLogger().handlers:
    import sys as _sys
    _h = _SafeStreamHandler(_sys.stdout)
    _h.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
    _root = logging.getLogger()
    _root.addHandler(_h)
    _root.setLevel(logging.INFO)

_STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Trade Buddy Web")

from webapp import auth  # noqa: E402  (after app/logging are set up)

# Paths reachable without a session: the SPA shell + its assets + the auth API
# itself, plus the clawbot bot-to-bot bridge (which carries its own token auth via
# CLAWBOT_API_TOKEN, not the browser session cookie). Everything else under /api
# requires a valid invitation-code session.
_OPEN_PREFIXES = ("/static", "/api/auth", "/favicon", "/api/clawbot")
_OPEN_PATHS = {"/", "/index.html"}


def _current_session(request: Request) -> Optional[auth.Session]:
    return auth.decode_session(request.cookies.get(auth.COOKIE_NAME, ""))


@app.middleware("http")
async def _gate(request: Request, call_next):
    """401 any API call without a valid session; let the shell + auth API through."""
    path = request.url.path
    if path in _OPEN_PATHS or path.startswith(_OPEN_PREFIXES):
        return await call_next(request)
    if path.startswith("/api/"):
        if _current_session(request) is None:
            return JSONResponse({"error": "auth_required"}, status_code=401)
    return await call_next(request)


def require_session(request: Request) -> auth.Session:
    """Dependency: the decoded session, or 401 (the gate normally catches first)."""
    sess = _current_session(request)
    if sess is None:
        raise HTTPException(status_code=401, detail="auth_required")
    return sess


def _set_session_cookie(resp: Response, request: Request, sess: auth.Session) -> None:
    secure = request.url.scheme == "https" or \
        request.headers.get("x-forwarded-proto", "").startswith("https")
    resp.set_cookie(
        auth.COOKIE_NAME, auth.encode_session(sess),
        max_age=auth._MAX_AGE, httponly=True, samesite="lax", secure=secure, path="/",
    )


def _session_status(sess: Optional[auth.Session]) -> Dict[str, Any]:
    if sess is None:
        return {"authed": False}
    return {
        "authed": True,
        "tier": sess.tier,
        "needs_keys": sess.tier == "guest" and not sess.deepseek_key,
        "has_llm_key": bool(sess.deepseek_key) or sess.is_invited,
        "has_alpaca": bool(sess.alpaca_keys()) or sess.is_invited,
    }


@app.get("/api/auth/me")
def auth_me(request: Request) -> Dict[str, Any]:
    """Current session status (tier + which guest keys are configured)."""
    return _session_status(_current_session(request))


@app.post("/api/auth/login")
def auth_login(request: Request, payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    """Exchange an invitation code for a session cookie."""
    tier = auth.tier_for_code(payload.get("code", ""))
    if tier is None:
        return JSONResponse({"error": "invalid_code"}, status_code=401)
    sess = auth.Session(tier=tier)
    resp = JSONResponse(_session_status(sess))
    _set_session_cookie(resp, request, sess)
    return resp


@app.post("/api/auth/keys")
def auth_keys(request: Request, payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    """Guest-only: save the visitor's own DeepSeek/Alpaca keys into their cookie."""
    sess = _current_session(request)
    if sess is None:
        return JSONResponse({"error": "auth_required"}, status_code=401)
    if sess.is_invited:
        return JSONResponse({"error": "invited_uses_owner_keys"}, status_code=400)
    ds = (payload.get("deepseek") or "").strip()
    ak = (payload.get("alpaca_key") or "").strip()
    asec = (payload.get("alpaca_secret") or "").strip()
    # Merge: blank fields keep whatever was there (lets them set Alpaca later).
    sess = auth.Session(
        tier="guest",
        deepseek_key=ds or sess.deepseek_key,
        alpaca_key=ak or sess.alpaca_key,
        alpaca_secret=asec or sess.alpaca_secret,
    )
    resp = JSONResponse(_session_status(sess))
    _set_session_cookie(resp, request, sess)
    return resp


@app.post("/api/auth/logout")
def auth_logout() -> JSONResponse:
    resp = JSONResponse({"authed": False})
    resp.delete_cookie(auth.COOKIE_NAME, path="/")
    return resp


@app.post("/api/export/zip")
def export_zip(request: Request, payload: Dict[str, Any] = Body(...)) -> Response:
    """Bundle several already-rendered report sections into one .zip download.

    The browser holds the markdown for each section, so it just POSTs
    ``{name, files: [{name, content}, …]}`` and gets back a zip — far simpler and
    more portable than assembling one client-side. Requires a session (the gate
    enforces it); the content originates from the caller's own run.
    """
    import io
    import re
    import zipfile

    require_session(request)
    files = payload.get("files") or []
    if not isinstance(files, list) or not files:
        return JSONResponse({"error": "no_files"}, status_code=400)

    def _safe(n: str, fallback: str) -> str:
        n = re.sub(r"[^\w.\-]+", "_", (n or "").strip()) or fallback
        return n[:120]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        seen: Dict[str, int] = {}
        for i, f in enumerate(files):
            fname = _safe(str(f.get("name", "")), f"section_{i + 1}")
            if not fname.lower().endswith(".md"):
                fname += ".md"
            # de-dupe identical filenames so none get silently dropped
            if fname in seen:
                seen[fname] += 1
                stem, _, ext = fname.rpartition(".")
                fname = f"{stem}_{seen[fname]}.{ext}"
            else:
                seen[fname] = 0
            zf.writestr(fname, str(f.get("content", "")))

    zip_name = _safe(str(payload.get("name", "")), "TradeBuddy_reports")
    if not zip_name.lower().endswith(".zip"):
        zip_name += ".zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{zip_name}"'},
    )

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

# Explicit chart/backtest intervals → (yfinance period to fetch the FULL window
# the provider allows, yfinance interval). Yahoo caps intraday history: 1m ≈ 7d,
# 5/15/30m ≈ 60d, 1h ≈ 730d; daily+ are effectively unlimited. Shared by the
# price chart (?interval=) and the backtester (see INTERVAL_MAX_DAYS).
_INTERVAL_PRESETS = {
    "1m":  ("7d",   "1m"),
    "5m":  ("60d",  "5m"),
    "15m": ("60d",  "15m"),
    "30m": ("60d",  "30m"),
    "1h":  ("730d", "1h"),
    "1d":  ("10y",  "1d"),
    "1wk": ("max",  "1wk"),
    "1mo": ("max",  "1mo"),
}

# Short-TTL cache for the price chart, keyed by (ticker, range, interval).
# During an analysis run the pipeline hammers yfinance; without this the chart's
# own yfinance call competes and often comes back rate-limited (429) → blank
# chart. Serving a recent response from memory keeps the chart instant and off
# Yahoo's throttle while a run is in flight. Intraday data is fine a minute stale.
import threading as _threading
import time as _time

_PRICE_CACHE: Dict[str, tuple] = {}
_PRICE_CACHE_TTL = 60.0   # seconds
_PRICE_CACHE_LOCK = _threading.Lock()

# Live-analysis run registry. A run's events are buffered here so a browser that
# refreshes (or reconnects) mid-analysis can replay everything and keep streaming
# the rest — the pipeline keeps running on its worker thread regardless of who is
# listening. Finished runs linger for _RUN_TTL so a late reconnect still gets the
# final verdict. All buffer mutations happen on the event loop thread (appended
# via call_soon_threadsafe), so no lock is needed on the asyncio side.
_RUNS: Dict[str, Dict[str, Any]] = {}
_RUN_TTL = 1800.0   # keep finished runs 30 min for late reconnects


def _gc_runs() -> None:
    now = _time.time()
    for rid in [r for r, s in _RUNS.items()
                if s.get("done") and now - s.get("ended", now) > _RUN_TTL]:
        _RUNS.pop(rid, None)

# Fixed pipeline topology for the frontend's animated flow graph: which agent's
# output flows to which next agent(s).
_FLOW_EDGES = {
    "Market Analyst": ["Bull Researcher", "Bear Researcher"],
    "Fundamentals Analyst": ["Bull Researcher", "Bear Researcher"],
    "News Analyst": ["Bull Researcher", "Bear Researcher"],
    "Sentiment Analyst": ["Bull Researcher", "Bear Researcher"],
    "Smart-Money Analyst": ["Bull Researcher", "Bear Researcher"],
    "Macro Analyst": ["Bull Researcher", "Bear Researcher"],
    "Bull Researcher": ["Judge"],
    "Bear Researcher": ["Judge"],
    "Judge": [],
}


# --------------------------------------------------------------------------- #
# Ticker search
# --------------------------------------------------------------------------- #
@app.get("/api/exchanges")
def exchanges() -> Dict[str, List[Dict[str, str]]]:
    """Country → exchanges map for the market-filter dropdowns."""
    return COUNTRY_EXCHANGES


@app.get("/api/symbols")
def symbols() -> List[Dict[str, str]]:
    """Full US ticker+name list for instant client-side English autosuggest.

    Loaded once by the frontend and filtered locally as the user types, so
    suggestions for a ticker ('aapl') or a company name ('apple') appear with no
    per-keystroke network round-trip.
    """
    return us_symbol_list()


# --------------------------------------------------------------------------- #
# Dashboard: economy + market news + AI analyst chat
# --------------------------------------------------------------------------- #
@app.get("/api/economy")
def economy() -> Dict[str, Any]:
    """Grouped global-economy indicator cards (rates, inflation, growth, risk)."""
    return {"groups": dashboard.economy_snapshot()}


@app.get("/api/market-news")
def market_news(
    symbol: Optional[str] = Query(None),
    limit: int = Query(30, ge=1, le=60),
) -> Dict[str, Any]:
    """Aggregated market news. Pass ``symbol`` for stock-specific news, else macro."""
    return {"news": dashboard.market_news(symbol=symbol, limit=limit)}


@app.get("/api/macro-series")
def macro_series(indicator: str = Query(...), points: int = Query(240, ge=12)) -> Dict[str, Any]:
    """Full time series for one economic indicator, for the click-through chart."""
    from tradingagents.dataflows.macro_utils import indicator_series

    points = min(points, 20000)  # clamp instead of rejecting, so the UI never 422s
    try:
        return indicator_series(indicator, max_points=points)
    except Exception as exc:  # noqa: BLE001
        logger.warning("macro-series %s failed: %s", indicator, exc)
        return {"indicator": indicator, "points": [], "latest": None, "error": str(exc)}


# --------------------------------------------------------------------------- #
# Watchlist
# --------------------------------------------------------------------------- #
@app.get("/api/watchlist")
def watchlist_get() -> Dict[str, Any]:
    """The watchlist with live quotes + sparklines."""
    return {"symbols": wl_mod.load(), "rows": wl_mod.enriched()}


@app.post("/api/watchlist")
def watchlist_add(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Add a symbol to the watchlist."""
    return {"symbols": wl_mod.add(str(payload.get("symbol", "")))}


@app.delete("/api/watchlist")
def watchlist_remove(symbol: str = Query(...)) -> Dict[str, Any]:
    """Remove a symbol from the watchlist."""
    return {"symbols": wl_mod.remove(symbol)}


@app.get("/api/quote")
def quote(ticker: str = Query(...)) -> Dict[str, Any]:
    """Quote header stats: price, OHLC, market cap, 52w range, PE, change windows."""
    return quote_mod.quote(ticker)


@app.get("/api/signals")
def signals(ticker: str = Query(...)) -> Dict[str, Any]:
    """Instant mechanical key signals + a baseline consensus tally."""
    sigs = quote_mod.signals(ticker)
    return {"signals": sigs, "consensus": quote_mod.consensus_from_signals(sigs)}


@app.get("/api/insights")
def insights(ticker: str = Query(...)) -> Dict[str, Any]:
    """Trend / support / resistance / outlook insights."""
    return quote_mod.insights(ticker)


@app.get("/api/financials")
def financials(ticker: str = Query(...)) -> Dict[str, Any]:
    """Quarterly financials (revenue/operating profit/net income, 5 qtrs) plus
    fundamental key-signals (EPS, ROE/ROA, margins, growth)."""
    from webapp import financials as fin_mod

    return fin_mod.financials(ticker)


@app.get("/api/statements")
def statements(
    ticker: str = Query(...),
    statement: str = Query("income"),
    period: str = Query("annual"),
    limit: int = Query(6, ge=2, le=12),
) -> Dict[str, Any]:
    """Raw XBRL financial statement straight from SEC EDGAR company facts.

    ``statement`` = income|balance|cashflow; ``period`` = annual|quarter.
    Backs the left "statements" pane of the Bloomberg-style analysis window.
    """
    from tradingagents.dataflows.sec_utils import financial_statement

    return financial_statement(ticker, statement=statement, period=period, limit=limit)


@app.get("/api/company/overview")
def company_overview(ticker: str = Query(...)) -> Dict[str, Any]:
    """Company description, profile, price snapshot + estimate/calendar summary."""
    from webapp import company
    return company.overview(ticker)


@app.get("/api/company/estimates")
def company_estimates(ticker: str = Query(...)) -> Dict[str, Any]:
    """Analyst price targets, recommendation tally, EPS/revenue/growth estimates."""
    from webapp import company
    return company.estimates(ticker)


@app.get("/api/company/calendar")
def company_calendar(ticker: str = Query(...)) -> Dict[str, Any]:
    """Upcoming & past earnings dates, recent dividends, splits."""
    from webapp import company
    return company.calendar(ticker)


@app.get("/api/company/ownership")
def company_ownership(ticker: str = Query(...)) -> Dict[str, Any]:
    """Institutional & major holders + recent insider transactions."""
    from webapp import company
    return company.ownership(ticker)


@app.get("/api/company/peers")
def company_peers(ticker: str = Query(...)) -> Dict[str, Any]:
    """Peer tickers (Finnhub) with a live quote/metric for each (comparison)."""
    from webapp import company
    return company.peers(ticker)


@app.get("/api/global/{panel}")
def global_markets(panel: str) -> Dict[str, Any]:
    """Global Markets terminal panels (one router for the whole macro dashboard).

    ``panel`` ∈ regime | heatmap | indices | bonds | commodities | fx | risk |
    flows | regional | calendar.
    """
    from webapp import globalmarkets as gm

    fns = {
        "regime": gm.regime, "heatmap": gm.heatmap, "indices": gm.indices,
        "bonds": gm.bond_yields, "commodities": gm.commodities, "fx": gm.fx,
        "risk": gm.risk, "flows": gm.asset_flows, "regional": gm.regional_macro,
        "calendar": gm.calendar,
    }
    fn = fns.get(panel)
    if not fn:
        return {"error": f"Unknown panel '{panel}'."}
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        logger.warning("global panel %s failed: %s", panel, exc)
        return {"error": str(exc), "rows": []}


@app.get("/api/indices")
def indices(rng: str = Query("1d", alias="range")) -> Dict[str, Any]:
    """Normalized %-change lines for S&P 500 / Nasdaq / Dow (news-page chart)."""
    from webapp import marketdata

    return marketdata.indices(rng)


@app.get("/api/movers")
def movers() -> Dict[str, Any]:
    """Top gainers / losers / most-active from a liquid large-cap universe."""
    from webapp import marketdata

    return marketdata.movers()


@app.get("/api/sectors")
def sectors(rng: str = Query("1d", alias="range")) -> Dict[str, Any]:
    """Sector performance (% change) from the SPDR sector ETFs."""
    from webapp import marketdata

    return marketdata.sectors(rng)


@app.post("/api/backtest")
def backtest(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Backtest a user-authored Python strategy in an isolated sandbox.

    Body: ``{code, ticker, start?, end?, cash?}``. The code must define
    ``generate_signals(data)`` returning a per-bar target position (-1..1).
    Returns ``{ok, metrics, equity_curve, trades}`` or ``{ok: false, error}``.
    """
    from webapp.backtest_engine import run_backtest

    interval = (payload.get("interval") or "1d").strip()
    if interval not in ("1m", "5m", "15m", "30m", "1h", "1d"):
        interval = "1d"
    return run_backtest(
        payload.get("code", ""),
        payload.get("ticker", ""),
        payload.get("start") or None,
        payload.get("end") or None,
        cash=float(payload.get("cash", 10000) or 10000),
        interval=interval,
    )


# --------------------------------------------------------------------------- #
# Portfolio — Alpaca PAPER trading (simulated money)
# --------------------------------------------------------------------------- #
# Guests trade their own Alpaca-paper account; invited users use the owner's.
def _alpaca_keys(request: Request):
    sess = _current_session(request)
    return sess.alpaca_keys() if (sess is not None and not sess.is_invited) else None


@app.get("/api/portfolio/account")
def portfolio_account(request: Request) -> Dict[str, Any]:
    from webapp import portfolio as pf
    return pf.account(keys=_alpaca_keys(request))


@app.get("/api/portfolio/positions")
def portfolio_positions(request: Request) -> Dict[str, Any]:
    from webapp import portfolio as pf
    return pf.positions(keys=_alpaca_keys(request))


@app.get("/api/portfolio/orders")
def portfolio_orders(request: Request, limit: int = Query(25, ge=1, le=100)) -> Dict[str, Any]:
    from webapp import portfolio as pf
    return pf.orders(limit, keys=_alpaca_keys(request))


@app.get("/api/portfolio/history")
def portfolio_history(request: Request, range: str = Query("1M")) -> Dict[str, Any]:
    """Account equity curve + range return and best/worst-day, win-rate stats."""
    from webapp import portfolio as pf
    return pf.history(range, keys=_alpaca_keys(request))


@app.post("/api/portfolio/order")
def portfolio_order(request: Request, payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Submit a paper order. Body: {symbol, qty, side, type?, limit_price?}."""
    from webapp import portfolio as pf
    return pf.place_order(
        payload.get("symbol", ""), payload.get("qty", 0),
        side=(payload.get("side") or "buy"),
        order_type=(payload.get("type") or "market"),
        limit_price=payload.get("limit_price"),
        keys=_alpaca_keys(request),
    )


@app.get("/api/ticker-news")
def ticker_news(ticker: str = Query(...), limit: int = Query(6, ge=1, le=20)) -> Dict[str, Any]:
    """Latest news cards for a specific ticker (via yfinance Search)."""
    import yfinance as yf
    from tradingagents.dataflows.stockstats_utils import yf_retry

    cards = []
    try:
        search = yf_retry(lambda: yf.Search(query=ticker, news_count=limit, enable_fuzzy_query=True))
        for a in (search.news or [])[:limit]:
            thumb = ""
            res = (a.get("thumbnail") or {}).get("resolutions") or []
            if res:
                thumb = res[0].get("url", "")
            cards.append({
                "title": a.get("title", ""), "publisher": a.get("publisher", ""),
                "link": a.get("link", ""), "published": a.get("providerPublishTime", 0),
                "thumbnail": thumb,
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning("ticker news for %s failed: %s", ticker, exc)
    # Newest first — yfinance Search returns its own relevance order, not by time.
    cards.sort(key=lambda c: c.get("published") or 0, reverse=True)
    return {"news": cards}


@app.get("/api/smart-money")
def smart_money(ticker: str = Query("")) -> Dict[str, Any]:
    """Smart-money flow: corporate insiders, congressional (Senate/House) trades,
    and 13F institutional holders. Pass ``ticker`` to filter; omit for latest."""
    return sm_mod.smart_money(ticker or None)


# ── Unified market calendar (curated macro + earnings + economic) ───────────
@app.get("/api/calendar")
def market_calendar() -> Dict[str, Any]:
    """Merged calendar: curated macro events, earnings, and economic releases."""
    return calendar_feed.unified_calendar()


# ── Whale Trading: ported keyless feeds (see webapp/whale.py) ───────────────
@app.get("/api/whale/congress")
def whale_congress() -> Dict[str, Any]:
    """Live STOCK Act congressional trades (QuiverQuant, with static fallback)."""
    return whale.congress()


@app.get("/api/whale/darkpool")
def whale_darkpool(ticker: str = Query("")) -> Dict[str, Any]:
    """FINRA Reg SHO short-volume dark-pool proxy. Pass ``ticker`` to filter."""
    return whale.darkpool(ticker or None)


@app.get("/api/whale/investors")
def whale_investors() -> Dict[str, Any]:
    """Famous investors' latest 13F holdings (Buffett/Burry/Ackman) + ARK daily."""
    return whale.investors()


@app.get("/api/whale/crypto")
def whale_crypto() -> Dict[str, Any]:
    """On-chain BTC/ETH balances of known whale wallets + live prices."""
    return whale.crypto_whales()


@app.get("/api/whale/stocks")
def whale_stocks(tickers: str = Query("")) -> Dict[str, Any]:
    """Batch daily quotes (comma-separated ``tickers``) for the heatmap grid."""
    return whale.stocks([t.strip().upper() for t in tickers.split(",") if t.strip()])


@app.get("/api/whale/options")
def whale_options(ticker: str = Query("SPY")) -> Dict[str, Any]:
    """Options flow for ``ticker``: P/C ratio, volumes, unusual activity + greeks."""
    return whale.options(ticker)


@app.get("/api/whale/wiki")
def whale_wiki(title: str = Query(...), context: str = Query("")) -> Dict[str, Any]:
    """Wikipedia bio + photo for a person (investors / congress members).

    ``context=politician`` biases resolution toward the elected official.
    """
    return whale.wiki_summary(title, context)


@app.post("/api/chat")
async def chat(request: Request, payload: Dict[str, Any] = Body(...)) -> StreamingResponse:
    """Stream one turn with the independent AI analyst as Server-Sent Events.

    Body: ``{message, history?, provider?, model?}``. Emits ``status`` events
    while the agent calls tools, then a ``done`` event with the answer. Streaming
    keeps the connection alive (no idle-timeout) and shows progress immediately.
    """
    message = (payload.get("message") or "").strip()
    history = payload.get("history") or []
    provider = (payload.get("provider") or "deepseek").lower()
    model = payload.get("model") or "deepseek-chat"
    session_id = payload.get("session_id") or None

    # Guests use their own DeepSeek key; invited users use the owner's env key.
    sess = _current_session(request)
    api_key = sess.llm_api_key() if sess is not None else None
    if sess is not None and not sess.is_invited and not api_key:
        async def _need_key():
            yield _sse({"type": "done",
                        "text": "⚠️ Add your DeepSeek API key (Settings) to chat with the analyst."})
        return StreamingResponse(_need_key(), media_type="text/event-stream")

    async def gen():
        if not message:
            yield _sse({"type": "done", "text": "Ask me anything about the macro backdrop, market news, or past analyses."})
            return
        analyst_chat.record_message("dashboard", "user", message, session_id=session_id)
        final_text = ""
        try:
            async for ev in analyst_chat.chat_stream(message, history, provider=provider, model=model, api_key=api_key):
                if ev.get("type") == "done":
                    final_text = ev.get("text") or final_text
                yield _sse(ev)
        except Exception as exc:  # noqa: BLE001
            logger.exception("chat failed")
            yield _sse({"type": "done", "text": f"⚠️ The analyst is unavailable: {exc}"})
        else:
            if final_text:
                analyst_chat.record_message("dashboard", "assistant", final_text, session_id=session_id)

    return StreamingResponse(gen(), media_type="text/event-stream")


# --------------------------------------------------------------------------- #
# Clawbot transmission path — bot-to-bot bridge to the Trade Buddy analyst.
#
# Lets the external "openclaw" clawbot (a) chat with Trade Buddy (with the full
# data + analysis-DB toolset and persistent memory), (b) commission the full
# analyst team as a background job, and (c) retrieve saved analyses and the
# conversation log. See webapp/static/clawbot_skill.md for the contract.
#
# Auth: if the env var CLAWBOT_API_TOKEN is set, every /api/clawbot/* route
# requires it via the `X-Trade-Buddy-Token` header (or `Authorization: Bearer
# <token>`). If it is unset, auth is disabled — fine for localhost, but set it
# before exposing the server on any public URL (e.g. a cloudflared tunnel), since
# these routes can spend LLM tokens.
# --------------------------------------------------------------------------- #
def _require_clawbot_auth(
    x_trade_buddy_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
) -> None:
    expected = os.environ.get("CLAWBOT_API_TOKEN", "").strip()
    if not expected:
        return  # no token configured → auth disabled (local/dev)
    supplied = x_trade_buddy_token
    if not supplied and authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if not supplied or supplied != expected:
        raise HTTPException(status_code=401, detail="invalid or missing clawbot token")


def _clawbot_store():
    from tradingagents.datastore import AnalysisStore, default_store_path
    from tradingagents.dataflows.config import get_config

    return AnalysisStore(default_store_path(get_config()["data_cache_dir"]))


@app.post("/api/clawbot/chat", dependencies=[Depends(_require_clawbot_auth)])
async def clawbot_chat(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """One non-streaming turn with Trade Buddy. Persists both sides under the
    given ``session_id`` so the conversation is remembered across calls.

    Body: ``{message, session_id?, history?, ticker?, provider?, model?}``.
    Returns ``{reply, session_id}``.
    """
    message = (payload.get("message") or "").strip()
    session_id = payload.get("session_id") or uuid.uuid4().hex[:12]
    history = payload.get("history") or []
    ticker = payload.get("ticker")
    provider = (payload.get("provider") or "deepseek").lower()
    model = payload.get("model") or "deepseek-chat"
    if not message:
        return {"reply": "Send a non-empty `message`.", "session_id": session_id}

    # Replay this session's stored history if the caller didn't supply any.
    if not history:
        try:
            history = [
                {"role": m["role"], "content": m["content"]}
                for m in _clawbot_store().recent_messages(session_id=session_id, limit=12)
            ]
        except Exception:  # noqa: BLE001
            history = []

    analyst_chat.record_message("clawbot", "user", message, session_id=session_id, ticker=ticker)
    try:
        reply = await analyst_chat.chat(message, history, provider=provider, model=model)
    except Exception as exc:  # noqa: BLE001
        logger.exception("clawbot chat failed")
        return {"reply": f"⚠️ Trade Buddy is unavailable: {exc}", "session_id": session_id}
    analyst_chat.record_message("clawbot", "assistant", reply, session_id=session_id, ticker=ticker)
    return {"reply": reply, "session_id": session_id}


@app.post("/api/clawbot/analyze", dependencies=[Depends(_require_clawbot_auth)])
def clawbot_analyze(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Commission the full analyst team for a ticker as a background job.

    Analyses take minutes, so this returns immediately with a ``job_id``; poll
    ``GET /api/clawbot/analyze/{job_id}``. The result is also saved to the store
    and retrievable via ``GET /api/clawbot/analysis``.

    Body: ``{ticker, date?, research_depth?, provider?, language?}``.
    """
    from webapp import analysis_runner

    ticker = (payload.get("ticker") or "").strip().upper()
    if not ticker:
        return {"error": "ticker is required"}
    job_id = analysis_runner.start_job(
        ticker,
        payload.get("date"),
        research_depth=int(payload.get("research_depth", 3)),
        provider=(payload.get("provider") or "deepseek").lower(),
        language=payload.get("language") or "English",
    )
    return {"job_id": job_id, "ticker": ticker, "status": "running",
            "poll": f"/api/clawbot/analyze/{job_id}"}


@app.get("/api/clawbot/analyze/{job_id}", dependencies=[Depends(_require_clawbot_auth)])
def clawbot_analyze_status(job_id: str) -> Dict[str, Any]:
    """Poll a background analysis job: ``running`` | ``done`` (+result) | ``error``."""
    from webapp import analysis_runner

    job = analysis_runner.get_job(job_id)
    if job is None:
        return {"error": "unknown job_id", "job_id": job_id}
    return job


@app.get("/api/clawbot/analysis", dependencies=[Depends(_require_clawbot_auth)])
def clawbot_analysis(ticker: str = Query(...)) -> Dict[str, Any]:
    """The most recent SAVED analysis for a ticker (verdict + scoreboard)."""
    sym = ticker.strip().upper()
    try:
        store = _clawbot_store()
        with store._conn() as conn:  # noqa: SLF001 — read-only
            a = conn.execute(
                "SELECT * FROM analyses WHERE ticker = ? "
                "ORDER BY trade_date DESC, id DESC LIMIT 1", (sym,),
            ).fetchone()
            if a is None:
                return {"ticker": sym, "found": False}
            a = dict(a)
            board = [dict(r) for r in conn.execute(
                "SELECT metric, source, raw_value, weight, score, note FROM scoreboard "
                "WHERE analysis_id = ? ORDER BY weight DESC", (a["id"],),
            ).fetchall()]
    except Exception as exc:  # noqa: BLE001
        return {"ticker": sym, "found": False, "error": str(exc)}
    return {
        "ticker": sym, "found": True, "trade_date": a.get("trade_date"),
        "rating": a.get("final_rating"), "weighted_score": a.get("weighted_score"),
        "verdict_md": a.get("verdict_md"), "scoreboard": board,
        "created_at": a.get("created_at"),
    }


@app.get("/api/clawbot/conversations", dependencies=[Depends(_require_clawbot_auth)])
def clawbot_conversations(
    session_id: Optional[str] = Query(None),
    channel: Optional[str] = Query(None),
    query: Optional[str] = Query(None),
    limit: int = Query(30, ge=1, le=200),
) -> Dict[str, Any]:
    """Read the conversation log: a session's turns, recent turns, or a search."""
    try:
        store = _clawbot_store()
        if query:
            rows = store.search_messages(query, limit=limit)
        else:
            rows = store.recent_messages(session_id=session_id, channel=channel, limit=limit)
    except Exception as exc:  # noqa: BLE001
        return {"messages": [], "error": str(exc)}
    return {"messages": rows, "count": len(rows)}


@app.on_event("startup")
def _warm_caches() -> None:
    """Warm slow caches in the background so the first load/chat is fast.

    The macro snapshot (for chat) and the economy + broad-news feeds (for the
    dashboard) are each ~9s live fetches; warming them off the request path turns
    the first page load from ~18s of blocking fetches into an instant read.

    A second daemon then *keeps* the slow Whale/Calendar/Insiders feeds warm on a
    fixed cadence, so clicking a tab is always an instant read of cached data
    instead of triggering (and blocking on) the live upstream fetch.
    """
    import threading

    def _warm_once() -> None:
        analyst_chat.prewarm_snapshot()
        dashboard.prewarm_dashboard()

    threading.Thread(target=_warm_once, daemon=True).start()
    threading.Thread(target=_cache_warmer_loop, daemon=True).start()


def _cache_warmer_loop() -> None:
    """Keep the click-to-load feeds warm in the background.

    Two kinds of feed:
      * **Forced** (Whale/Calendar) — recompute fresh data on a per-feed cadence.
      * **Lazy** (Markets/News/economy) — already TTL-cached, so we just *call*
        them each pass; the call is a cheap cache hit until the TTL lapses, at
        which point the refetch lands on this thread instead of a user's click.
    """
    import threading

    from webapp import calendar_feed, globalmarkets as gm

    # (label, refresh fn, how often in seconds, log_each). Each runs in its OWN
    # thread, so feeds warm concurrently at boot (≈ the slowest single feed, not
    # their sum) and a slow one never blocks the others. Whale/Calendar feeds are
    # force-refreshed (via prewarm_*); Markets/News/economy self-cache, so calling
    # them on a sub-TTL cadence just lands the refetch here, not on a user click.
    # Cadences sit under each feed's TTL; 13F holdings refresh slowest (quarterly).
    tasks = [
        ("congress",   whale.prewarm_congress,                 600, True),
        ("darkpool",   whale.prewarm_darkpool,                 900, True),
        ("investors",  whale.prewarm_investors,               3600, True),
        ("calendar",   calendar_feed.prewarm,                  900, True),
        ("insiders",   sm_mod.prewarm,                         600, True),
        ("economy",    lambda: dashboard.economy_snapshot(),   300, True),
        ("news",       lambda: dashboard.market_news(None, 60), 150, True),
        ("news-dash",  lambda: dashboard.market_news(None, 45), 150, False),
        ("mkt:regime", gm.regime,                              240, False),
        ("mkt:indices", gm.indices,                            240, False),
        ("mkt:bonds",  gm.bond_yields,                         600, False),
        ("mkt:commodities", gm.commodities,                    240, False),
        ("mkt:fx",     gm.fx,                                  240, False),
        ("mkt:risk",   gm.risk,                                240, False),
        ("mkt:flows",  gm.asset_flows,                         600, False),
        ("mkt:heatmap", gm.heatmap,                           3600, False),
    ]

    def _periodic(label: str, fn, every: float, log_each: bool) -> None:
        while True:
            try:
                fn()
                if log_each:
                    logger.info("cache warmer: refreshed %s", label)
            except Exception:  # noqa: BLE001
                logger.warning("cache warmer: %s refresh failed", label, exc_info=False)
            _time.sleep(every)

    threads = [threading.Thread(target=_periodic, args=t, daemon=True) for t in tasks]
    for th in threads:
        th.start()
    for th in threads:           # keep this warmer thread alive alongside its children
        th.join()


@app.get("/api/search")
def search(
    q: str = Query(..., min_length=1),
    exchange: Optional[str] = Query(None),
) -> List[Dict[str, str]]:
    """Autocomplete tickers by name or symbol, case-insensitive.

    When ``exchange`` is given (e.g. ``SSE``, ``NSE``, ``US``), results are scoped
    to that exchange — China boards use the AKShare A-share list, others use Yahoo
    filtered by exchange suffix. Without ``exchange``, falls back to a global
    Yahoo search (legacy behavior).
    """
    if exchange:
        return search_exchange(q, exchange, limit=10)
    # Yahoo's search can't match Chinese-language names, so a CJK query in the
    # global ("All") box returns nothing. Route those to the A-share name table,
    # which carries the Chinese names. Latin queries keep using Yahoo.
    if any("一" <= ch <= "鿿" for ch in q):
        hits = search_china_all(q, limit=10)
        if hits:
            return hits
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
# Approximate calendar-day lookback per range, for trimming daily fallback bars.
_RANGE_DAYS = {
    "1d": 5, "5d": 7, "1w": 7, "1m": 31, "3m": 93, "6m": 186,
    "ytd": 366, "1y": 366, "5y": 1830, "max": 100000,
}


def _china_prices_fallback(ticker: str, range: str) -> Optional[Dict[str, Any]]:
    """Daily candles for a China A-share via AKShare, or None if not applicable.

    yfinance often returns nothing for ``.SS`` / ``.SZ`` listings; AKShare is the
    reliable source. Only daily granularity is available, so intraday ranges show
    daily bars trimmed to the range window.
    """
    from tradingagents.dataflows.akshare_utils import is_china_a_share, load_ohlcv_akshare

    if not is_china_a_share(ticker):
        return None
    try:
        today = dt.date.today().strftime("%Y-%m-%d")
        df = load_ohlcv_akshare(ticker, today)
    except Exception as exc:  # noqa: BLE001 — AKShare unreachable
        logger.warning("AKShare price fallback failed for %s: %s", ticker, exc)
        return None
    if df is None or df.empty:
        return None

    cutoff = dt.date.today() - dt.timedelta(days=_RANGE_DAYS.get(range, 93))
    df = df[df["Date"] >= pd.Timestamp(cutoff)]
    candles = [
        {
            "t": int(pd.Timestamp(row["Date"]).timestamp() * 1000),
            "o": round(float(row["Open"]), 4),
            "h": round(float(row["High"]), 4),
            "l": round(float(row["Low"]), 4),
            "c": round(float(row["Close"]), 4),
            "v": int(row["Volume"]) if pd.notna(row["Volume"]) else 0,
        }
        for _, row in df.iterrows()
    ]
    if not candles:
        return None
    last, first = candles[-1]["c"], candles[0]["c"]
    change_pct = ((last - first) / first * 100.0) if first else None
    return {
        "ticker": ticker, "range": range, "last": last,
        "change_pct": change_pct, "candles": candles, "source": "akshare",
    }


@app.get("/api/prices")
def prices(
    ticker: str = Query(...),
    range: str = Query("3m"),
    interval: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Return OHLCV candles for ``ticker``.

    Two modes: a named ``range`` preset (dashboard quick views), or an explicit
    ``interval`` (1m/5m/15m/30m/1h/1d/1wk/1mo) that fetches the longest window
    the provider allows for that interval — used by the KLineChart Pro chart so
    intraday views aren't limited to a single (possibly empty) trading day.
    """
    from tradingagents.dataflows.stockstats_utils import yf_retry

    use_interval = interval in _INTERVAL_PRESETS
    if use_interval:
        period, yf_interval = _INTERVAL_PRESETS[interval]
    else:
        period, yf_interval = _RANGES.get(range, _RANGES["3m"])

    # Serve a recent response from cache so the chart stays instant (and off
    # Yahoo's rate limiter) while an analysis run is hammering yfinance.
    cache_key = f"{ticker.upper()}|{range}|{interval or ''}"
    now = _time.time()
    with _PRICE_CACHE_LOCK:
        hit = _PRICE_CACHE.get(cache_key)
    if hit is not None and now - hit[0] < _PRICE_CACHE_TTL:
        return hit[1]

    tk = yf.Ticker(ticker)
    try:
        hist = yf_retry(lambda: tk.history(period=period, interval=yf_interval))

        # 1-minute history is flaky; retry a shorter window before giving up.
        if use_interval and interval == "1m" and hist.empty:
            hist = yf_retry(lambda: tk.history(period="5d", interval="1m"))

        # 1D: today's 1-min bars; fall back to most recent trading day when empty
        if not use_interval and range == "1d" and hist.empty:
            hist = yf_retry(lambda: tk.history(period="5d", interval="1m"))
            if not hist.empty:
                last_date = hist.index.to_series().dt.date.iloc[-1]
                hist = hist[hist.index.to_series().dt.date == last_date]

        # 3M: yfinance has no 2h interval — aggregate 1h bars into 2h bars
        if not use_interval and range == "3m" and not hist.empty:
            hist = (
                hist.resample("2h")
                .agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"})
                .dropna(subset=["Close"])
            )

    except Exception as exc:  # noqa: BLE001
        hist = None
        yf_error = str(exc)
    else:
        yf_error = None

    # China A-shares: yfinance is unreliable, so fall back to AKShare daily bars.
    if hist is None or hist.empty:
        china = _china_prices_fallback(ticker, range)
        if china is not None:
            return china
        if hist is None:
            return {"ticker": ticker, "range": range, "candles": [], "error": yf_error}

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

    payload = {
        "ticker": ticker,
        "range": range,
        "last": last,
        "change_pct": change_pct,
        "candles": candles,
    }
    if candles:   # only cache real data, never an empty/error response
        with _PRICE_CACHE_LOCK:
            _PRICE_CACHE[cache_key] = (now, payload)
    return payload


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
    request: Request,
    ticker: Optional[str] = Query(None),   # required for a new run; omitted when resuming
    date: Optional[str] = Query(None),
    analysts: str = Query("market,social,news,fundamentals,smart_money,macro"),
    provider: str = Query("deepseek"),
    quick: Optional[str] = Query(None),
    deep: Optional[str] = Query(None),
    backend_url: Optional[str] = Query(None),
    research_depth: int = Query(3, ge=1, le=5),
    language: str = Query("English"),
    resume: Optional[str] = Query(None),
):
    """Run the pipeline and stream live events as Server-Sent Events.

    Pass ``resume=<run_id>`` to reattach to an in-flight (or just-finished) run
    instead of starting a new one — the buffered events are replayed, then live
    events continue. This is what lets a page refresh not lose the conversation.
    """
    # Reconnect path: replay a run's buffer + tail it. Never start a new pipeline
    # here — an unknown/expired id streams a clean "not available" (so a refresh
    # after the TTL or a server restart can't silently launch a fresh analysis).
    if resume:
        return StreamingResponse(_subscribe_run(resume), media_type="text/event-stream")

    # New run: ticker is required (it's optional in the signature only so a
    # resume URL without a ticker passes validation instead of 422-ing).
    if not ticker:
        async def _no_ticker():
            yield _sse({"type": "error", "message": "No ticker provided."})
            yield _sse({"type": "close"})
        return StreamingResponse(_no_ticker(), media_type="text/event-stream")

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

    # Guests run on their own DeepSeek key; invited users run on the owner's env
    # key. A guest who hasn't entered a key gets a clear SSE error, not a 500.
    sess = _current_session(request)
    if sess is not None and not sess.is_invited:
        if not sess.llm_api_key():
            async def _need_key():
                yield _sse({"type": "error",
                            "message": "Add your DeepSeek API key (Settings) to run an analysis."})
                yield _sse({"type": "close"})
            return StreamingResponse(_need_key(), media_type="text/event-stream")
        config["llm_api_key"] = sess.llm_api_key()

    loop = asyncio.get_running_loop()
    _gc_runs()
    run_id = uuid.uuid4().hex[:16]
    state = {"events": [], "done": False, "started": _time.time(), "ended": 0.0,
             "ticker": ticker, "signal": asyncio.Event()}
    _RUNS[run_id] = state

    def emit(event: Dict[str, Any]) -> None:
        # Append to the run's buffer on the loop thread and wake subscribers.
        def _append() -> None:
            st = _RUNS.get(run_id)
            if st is None:
                return
            st["events"].append(event)
            if event.get("type") == "_end":
                st["done"] = True
                st["ended"] = _time.time()
            st["signal"].set()
        loop.call_soon_threadsafe(_append)

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

    # Seed the buffer with the start event (carries run_id so the client can
    # store it and resume after a refresh), then launch the pipeline.
    emit({"type": "start", "run_id": run_id, "ticker": ticker,
          "date": trade_date, "analysts": selected})
    loop.run_in_executor(None, run)

    return StreamingResponse(_subscribe_run(run_id), media_type="text/event-stream")


@app.get("/api/analyze/active")
def analyze_active() -> Dict[str, Any]:
    """The most recent still-running analysis, for auto-reconnect after a refresh.

    The browser calls this on load; if a run is live it reattaches via
    ``/api/analyze?resume=<run_id>``. This works even when the page that started
    the run is gone (so localStorage is empty) — the server is the source of
    truth for what's still running.
    """
    _gc_runs()
    live = [(rid, s) for rid, s in _RUNS.items() if not s.get("done")]
    if not live:
        return {"active": False}
    rid, s = max(live, key=lambda kv: kv[1].get("started", 0.0))
    return {"active": True, "run_id": rid, "ticker": s.get("ticker", "")}


async def _subscribe_run(run_id: str):
    """Yield a run's buffered events then tail live ones until it ends.

    Multiple subscribers can read the same run independently (each tracks its own
    position), so a refresh simply opens a fresh subscription that replays from
    the top. Sends an SSE keepalive comment while idle so proxies don't drop the
    connection during long agent turns.
    """
    state = _RUNS.get(run_id)
    if state is None:
        yield _sse({"type": "error", "message": "That analysis is no longer available."})
        yield _sse({"type": "close"})
        return
    idx = 0
    while True:
        events = state["events"]
        while idx < len(events):
            ev = events[idx]
            idx += 1
            if ev.get("type") == "_end":
                yield _sse({"type": "close"})
                return
            yield _sse(ev)
        if state.get("done"):
            yield _sse({"type": "close"})
            return
        # Wait for the next event; re-check after clearing to avoid a lost wakeup.
        state["signal"].clear()
        if idx < len(state["events"]):
            continue
        try:
            await asyncio.wait_for(state["signal"].wait(), timeout=20)
        except asyncio.TimeoutError:
            yield ": keepalive\n\n"


# --------------------------------------------------------------------------- #
# Static frontend
# --------------------------------------------------------------------------- #
@app.get("/")
def index() -> FileResponse:
    return FileResponse(_STATIC / "index.html")


app.mount("/static", StaticFiles(directory=str(_STATIC)), name="static")
