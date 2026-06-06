"""Alpaca **paper** trading for the Portfolio page.

Thin wrapper over the official ``alpaca-py`` SDK, locked to the paper-trading
endpoint (simulated money — no real orders). Credentials come from the
environment (loaded from ``.env``):

    ALPACA_API_KEY=...
    ALPACA_SECRET_KEY=...

Get free paper keys at https://alpaca.markets → Paper Trading → API Keys. If the
SDK isn't installed or keys are missing, every call returns
``{"connected": False, "error": ...}`` so the UI can show a setup notice instead
of crashing.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

_PAPER_BASE = "https://paper-api.alpaca.markets"

# range → Alpaca portfolio-history (period, timeframe)
_HISTORY_RANGES = {
    "1D": ("1D", "5Min"),
    "1W": ("1W", "15Min"),
    "1M": ("1M", "1D"),
    "3M": ("3M", "1D"),
    "1Y": ("1A", "1D"),
    "All": ("all", "1D"),
}


def _keys(override: Optional[tuple[str, str]] = None) -> tuple[str, str]:
    """API key + secret. A guest's ``override`` wins; else the server env vars."""
    if override and override[0] and override[1]:
        return override[0].strip(), override[1].strip()
    key = (os.environ.get("ALPACA_API_KEY")
           or os.environ.get("APCA_API_KEY_ID")
           or os.environ.get("ALPACA_API_KEY_ID") or "").strip()
    secret = (os.environ.get("ALPACA_SECRET_KEY")
              or os.environ.get("APCA_API_SECRET_KEY")
              or os.environ.get("ALPACA_API_SECRET_KEY") or "").strip()
    return key, secret


def _client(keys: Optional[tuple[str, str]] = None):
    """A paper TradingClient, or raise with a clear, user-facing message."""
    key, secret = _keys(keys)
    if not key or not secret:
        raise RuntimeError(
            "Alpaca keys not set. Add ALPACA_API_KEY and ALPACA_SECRET_KEY "
            "(or APCA_API_KEY_ID / APCA_API_SECRET_KEY) to .env.")
    try:
        from alpaca.trading.client import TradingClient
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("alpaca-py is not installed. Run: pip install alpaca-py") from exc
    return TradingClient(key, secret, paper=True)  # paper=True → paper-api.alpaca.markets


def _err(exc: Exception) -> Dict[str, Any]:
    return {"connected": False, "error": str(exc)}


def account(keys: Optional[tuple[str, str]] = None) -> Dict[str, Any]:
    """Account summary (equity, cash, buying power, day P&L). Paper account."""
    try:
        a = _client(keys).get_account()
    except Exception as exc:  # noqa: BLE001
        return _err(exc)
    equity = float(a.equity or 0)
    last_equity = float(a.last_equity or 0)
    out = {
        "connected": True,
        "status": str(getattr(a, "status", "")),
        "currency": a.currency,
        "equity": equity,
        "cash": float(a.cash or 0),
        "buying_power": float(a.buying_power or 0),
        "long_market_value": float(getattr(a, "long_market_value", 0) or 0),  # value of stock held
        "portfolio_value": float(a.portfolio_value or 0),
        "day_pl": equity - last_equity,
        "day_pl_pct": ((equity - last_equity) / last_equity) if last_equity else 0.0,
    }
    # All-time Total P&L / Return from the account's starting value (best-effort).
    try:
        raw = _history_raw("all", "1D", keys=keys)
        base = float(raw.get("base_value") or 0)
        if base:
            out["total_pl"] = equity - base
            out["total_return"] = (equity - base) / base
    except Exception:  # noqa: BLE001
        pass
    return out


def _history_raw(period: str, timeframe: str,
                 keys: Optional[tuple[str, str]] = None) -> Dict[str, Any]:
    """Raw Alpaca portfolio-history JSON (timestamp/equity/profit_loss/base_value)."""
    key, secret = _keys(keys)
    resp = requests.get(
        f"{_PAPER_BASE}/v2/account/portfolio/history",
        params={"period": period, "timeframe": timeframe, "extended_hours": "false"},
        headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret},
        timeout=12,
    )
    resp.raise_for_status()
    return resp.json()


def history(rng: str = "1M", keys: Optional[tuple[str, str]] = None) -> Dict[str, Any]:
    """Equity curve for ``rng`` + range return and best/worst-day, win-rate stats."""
    if not _keys(keys)[0]:
        return _err(RuntimeError("Alpaca keys not set."))
    period, timeframe = _HISTORY_RANGES.get(rng, _HISTORY_RANGES["1M"])
    try:
        d = _history_raw(period, timeframe, keys=keys)
    except Exception as exc:  # noqa: BLE001
        return _err(exc)
    import datetime as _dt

    ts = d.get("timestamp") or []
    eq = d.get("equity") or []
    pls = d.get("profit_loss") or []
    intraday = timeframe.endswith("Min") or timeframe.endswith("H")
    points, days = [], []
    for i, (t, e) in enumerate(zip(ts, eq)):
        # Skip empty/pre-funding points: Alpaca's history leads with equity 0.0
        # before the account is funded, and the 0 → deposit jump would otherwise
        # render as a ±(deposit) spike in the curve and best/worst-day stats.
        if e is None or float(e) <= 0:
            continue
        dtm = _dt.datetime.fromtimestamp(int(t))
        label = dtm.strftime("%Y-%m-%d %H:%M") if intraday else dtm.strftime("%Y-%m-%d")
        points.append({"t": label, "equity": round(float(e), 2)})
        if i < len(pls) and pls[i] is not None:
            days.append({"date": dtm.strftime("%Y-%m-%d"), "pl": float(pls[i])})

    # Daily ranges (1M+) end at the previous settled close — a day behind the live
    # account, so the curve can read slightly negative even when the account is up
    # today. Append the live equity as a final "today" point so the curve and the
    # range return end at *now*. (Intraday ranges already include the latest tick.)
    if points:
        try:
            live = float(_client(keys).get_account().equity or 0)
            if live > 0:
                today = _dt.datetime.now().strftime("%Y-%m-%d")
                if not intraday and points[-1]["t"][:10] < today:
                    points.append({"t": today, "equity": round(live, 2)})
                else:
                    # Overwrite the latest point — a stale daily seed (prior close) or
                    # an intraday bar that lags the live equity — so EVERY range ends
                    # at the same "now" value. Otherwise short vs long ranges end on
                    # different numbers and their returns don't reconcile.
                    points[-1]["equity"] = round(live, 2)
        except Exception:  # noqa: BLE001
            pass

    # Base = equity at the window's start. Alpaca's base_value is best; fall back
    # to the first *non-zero* equity point (intraday feeds can lead with zeros
    # before the account/market opens, which would distort the return).
    base = float(d.get("base_value") or 0)
    if base <= 0:
        base = next((p["equity"] for p in points if p["equity"] > 0), points[0]["equity"] if points else 0.0)
    cur = points[-1]["equity"] if points else base

    # Best/worst DAY = the biggest close-to-close change in EQUITY per calendar
    # date. We derive it from the equity series (not Alpaca's profit_loss, which
    # is cumulative-from-base): take each date's closing equity, then diff it
    # against the prior date's close. This makes a single date appear once, so it
    # can never be reported as both the best (+) and the worst (-) day, and works
    # for intraday ranges (one net change per day) and daily ranges alike.
    stats = {"best_day": 0.0, "worst_day": 0.0, "win_rate": 0.0, "win_days": 0, "total_days": 0}
    day_close: Dict[str, float] = {}             # dict preserves insertion order
    for p in points:
        day_close[p["t"][:10]] = p["equity"]      # last point of each date wins → its close
    daily, prev = [], base
    for dte, close in day_close.items():
        daily.append({"date": dte, "pl": close - prev})
        prev = close
    # Exclude zero-change days and any deposit/withdrawal-sized swing (≥50% of the
    # base is a cash transfer, not a trading day) so a funding event never shows up
    # as the best/worst day or skews the win rate.
    deposit_floor = 0.5 * base if base else float("inf")
    nz = [x for x in daily if round(x["pl"], 2) != 0 and abs(x["pl"]) < deposit_floor]
    if nz:
        best = max(nz, key=lambda x: x["pl"])
        worst = min(nz, key=lambda x: x["pl"])
        wins = sum(1 for x in nz if x["pl"] > 0)
        stats = {
            "best_day": round(best["pl"], 2), "best_day_date": best["date"],
            "worst_day": round(worst["pl"], 2), "worst_day_date": worst["date"],
            "win_rate": wins / len(nz), "win_days": wins, "total_days": len(nz),
        }
    return {
        "connected": True, "range": rng, "intraday": intraday,
        "base_value": base, "points": points,
        "range_pl": cur - base,
        "range_return": ((cur - base) / base) if base else 0.0,
        **stats,
    }


def positions(keys: Optional[tuple[str, str]] = None) -> Dict[str, Any]:
    """Open positions with unrealised P&L."""
    try:
        rows = _client(keys).get_all_positions()
    except Exception as exc:  # noqa: BLE001
        return _err(exc)
    out: List[dict] = []
    for p in rows:
        out.append({
            "symbol": p.symbol,
            "qty": float(p.qty),
            "side": str(getattr(p, "side", "")).split(".")[-1].lower(),
            "avg_entry": float(p.avg_entry_price or 0),
            "current_price": float(p.current_price or 0),
            "market_value": float(p.market_value or 0),
            "unrealized_pl": float(p.unrealized_pl or 0),
            "unrealized_plpc": float(p.unrealized_plpc or 0),
        })
    return {"connected": True, "positions": out}


def orders(limit: int = 25, keys: Optional[tuple[str, str]] = None) -> Dict[str, Any]:
    """Recent orders (all statuses), newest first."""
    try:
        from alpaca.trading.requests import GetOrdersRequest
        from alpaca.trading.enums import QueryOrderStatus

        client = _client(keys)
        req = GetOrdersRequest(status=QueryOrderStatus.ALL, limit=int(limit))
        rows = client.get_orders(filter=req)
    except Exception as exc:  # noqa: BLE001
        return _err(exc)
    out: List[dict] = []
    for o in rows:
        out.append({
            "symbol": o.symbol,
            "side": str(o.side).split(".")[-1].lower(),
            "qty": float(o.qty) if o.qty else None,
            "type": str(o.order_type).split(".")[-1].lower(),
            "status": str(o.status).split(".")[-1].lower(),
            "filled_avg_price": float(o.filled_avg_price) if o.filled_avg_price else None,
            "submitted_at": str(o.submitted_at) if o.submitted_at else None,
        })
    return {"connected": True, "orders": out}


def place_order(symbol: str, qty: float, side: str = "buy",
                order_type: str = "market", limit_price: float | None = None,
                keys: Optional[tuple[str, str]] = None) -> Dict[str, Any]:
    """Submit a paper order (market or limit). Returns the created order or an error."""
    sym = (symbol or "").strip().upper()
    if not sym or not qty or float(qty) <= 0:
        return {"ok": False, "error": "Provide a symbol and a positive quantity."}
    try:
        from alpaca.trading.requests import MarketOrderRequest, LimitOrderRequest
        from alpaca.trading.enums import OrderSide, TimeInForce

        client = _client(keys)
        oside = OrderSide.BUY if side.lower() == "buy" else OrderSide.SELL
        if order_type.lower() == "limit":
            if not limit_price:
                return {"ok": False, "error": "Limit orders need a limit price."}
            req = LimitOrderRequest(symbol=sym, qty=float(qty), side=oside,
                                    time_in_force=TimeInForce.DAY, limit_price=float(limit_price))
        else:
            req = MarketOrderRequest(symbol=sym, qty=float(qty), side=oside,
                                     time_in_force=TimeInForce.DAY)
        o = client.submit_order(order_data=req)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "order_id": str(o.id), "symbol": o.symbol,
            "side": str(o.side).split(".")[-1].lower(),
            "qty": float(o.qty) if o.qty else None,
            "status": str(o.status).split(".")[-1].lower()}
