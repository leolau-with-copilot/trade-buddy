"""Standalone runner for UNTRUSTED user backtest code.

Executed in an isolated subprocess (see ``backtest_engine.py``). It deliberately
imports **only** stdlib + pandas/numpy and never the ``webapp``/``tradingagents``
packages, so even if isolation is imperfect this process has no handle on app
config, secrets, or the analysis DB.

Contract for the user's code: define ``generate_signals(data)`` taking a pandas
DataFrame (columns: open/high/low/close/volume, DatetimeIndex) and returning a
per-bar target position as a Series/array (-1 short … 0 flat … 1 long). The
engine applies the signal on the *next* bar (no look-ahead) and computes a full
research report: KPIs, equity + benchmark + drawdown curves, a monthly-returns
matrix, and round-trip trades with hold time and PnL.

Argv: data_csv  code_path  out_path  params_json
Result (always to out_path as JSON): {ok, metrics, equity_curve, drawdown,
monthly, trades, trade_stats} or {ok: false, error, trace}.
"""
from __future__ import annotations

import json
import sys
import traceback

import numpy as np
import pandas as pd

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _round_trips(pos, equity, close, index):
    """Pair entries→exits into round-trip trades with PnL and hold time."""
    trades = []
    prev = 0.0
    entry_i = None
    n = len(pos)
    arr = pos.values
    for i in range(n):
        p = float(arr[i])
        if p != prev:
            if prev != 0 and entry_i is not None:
                trades.append(_close_trade(prev, entry_i, i, equity, close, index))
            entry_i = i if p != 0 else None
            prev = p
    if prev != 0 and entry_i is not None:        # close the open position at the end
        trades.append(_close_trade(prev, entry_i, n - 1, equity, close, index))
    return trades


def _close_trade(side_val, ei, xi, equity, close, index):
    ent_px = float(close.iloc[ei])
    ex_px = float(close.iloc[xi])
    direction = 1.0 if side_val > 0 else -1.0
    ret = (ex_px / ent_px - 1.0) * direction if ent_px else 0.0
    ent_eq = float(equity.iloc[ei]) or 0.0
    ent_dt, ex_dt = index[ei], index[xi]
    # Show the intraday time tick for hourly/minute bars; just the date for daily.
    def _stamp(d):
        return d.strftime("%Y-%m-%d %H:%M") if (getattr(d, "hour", 0) or getattr(d, "minute", 0)) else str(d.date())
    return {
        "entry_date": _stamp(ent_dt),
        "exit_date": _stamp(ex_dt),
        "side": "long" if side_val > 0 else "short",
        "entry_price": round(ent_px, 2),
        "exit_price": round(ex_px, 2),
        "pnl_pct": ret,
        "pnl": round(ret * ent_eq, 2),
        "hold_days": int((ex_dt - ent_dt).days),
    }


def _monthly_matrix(strat_ret):
    """{year: {Jan..Dec: pct, YTD: pct}} of compounded monthly returns."""
    monthly = (1 + strat_ret).resample("ME").prod() - 1
    yearly = (1 + strat_ret).resample("YE").prod() - 1
    out = {}
    for ts, val in monthly.items():
        y = str(ts.year)
        out.setdefault(y, {})[_MONTHS[ts.month - 1]] = round(float(val) * 100, 1)
    for ts, val in yearly.items():
        out.setdefault(str(ts.year), {})["YTD"] = round(float(val) * 100, 1)
    return out


def _run(data_csv, code_path, params_path):
    params = json.load(open(params_path, encoding="utf-8"))
    cash = float(params.get("cash", 10000))

    data = pd.read_csv(data_csv, parse_dates=["date"]).set_index("date")
    data.index = pd.to_datetime(data.index)       # guarantee a DatetimeIndex for resample()
    code = open(code_path, encoding="utf-8").read()

    ns = {"pd": pd, "np": np}
    exec(compile(code, "<strategy>", "exec"), ns)  # noqa: S102 — sandboxed on purpose
    fn = ns.get("generate_signals")
    if not callable(fn):
        raise ValueError("Your code must define a function generate_signals(data).")

    raw = fn(data.copy())
    sig = raw if isinstance(raw, pd.Series) else pd.Series(np.asarray(raw), index=data.index[: len(np.asarray(raw))])
    sig = sig.reindex(data.index).fillna(0).clip(-1, 1)

    pos = sig.shift(1).fillna(0)                  # trade next bar → no look-ahead
    ret = data["close"].pct_change().fillna(0)
    strat_ret = pos * ret
    equity = (1 + strat_ret).cumprod() * cash
    bench = (1 + ret).cumprod() * cash
    dd = equity / equity.cummax() - 1

    trades = _round_trips(pos, equity, data["close"], data.index)

    # --- KPIs ---------------------------------------------------------------
    days = max(1, (data.index[-1] - data.index[0]).days)
    growth = float(equity.iloc[-1] / cash)
    std = strat_ret.std()
    downside = strat_ret[strat_ret < 0].std()
    pnls = [t["pnl"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_win, gross_loss = sum(wins), abs(sum(losses))
    metrics = {
        "total_return": float(growth - 1),
        "bench_return": float(bench.iloc[-1] / cash - 1),
        "cagr": float(growth ** (365 / days) - 1) if growth > 0 else -1.0,
        "sharpe": float(np.sqrt(252) * strat_ret.mean() / std) if std > 0 else 0.0,
        "sortino": float(np.sqrt(252) * strat_ret.mean() / downside) if downside and downside > 0 else 0.0,
        "max_drawdown": float(dd.min()),
        "volatility": float(std * np.sqrt(252)),
        "exposure": float((pos != 0).mean()),
        "win_rate": (len(wins) / len(trades)) if trades else 0.0,
        "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else (gross_win and 99.0 or 0.0),
        "num_trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "final_equity": round(float(equity.iloc[-1]), 2),
    }

    # --- trade stats --------------------------------------------------------
    trade_stats = {}
    if trades:
        best = max(trades, key=lambda t: t["pnl_pct"])
        worst = min(trades, key=lambda t: t["pnl_pct"])
        trade_stats = {
            "best_pct": best["pnl_pct"], "best_window": f"{best['entry_date']} → {best['exit_date']}",
            "worst_pct": worst["pnl_pct"], "worst_window": f"{worst['entry_date']} → {worst['exit_date']}",
            "avg_pct": float(np.mean([t["pnl_pct"] for t in trades])),
            "avg_hold": float(np.mean([t["hold_days"] for t in trades])),
        }

    # --- downsampled aligned curves ----------------------------------------
    step = max(1, len(equity) // 300)
    eq_i = equity.index[::step]
    curve = [{"date": str(d.date()), "equity": round(float(e), 2), "bench": round(float(b), 2)}
             for d, e, b in zip(eq_i, equity.values[::step], bench.values[::step])]
    draw = [{"date": str(d.date()), "dd": round(float(v) * 100, 2)}
            for d, v in zip(eq_i, dd.values[::step])]

    return {
        "ok": True, "metrics": metrics, "equity_curve": curve, "drawdown": draw,
        "monthly": _monthly_matrix(strat_ret), "trades": trades[-500:], "trade_stats": trade_stats,
    }


def main() -> None:
    out_path = sys.argv[3]
    try:
        result = _run(sys.argv[1], sys.argv[2], sys.argv[4])
    except Exception as exc:  # noqa: BLE001 — report any user/runtime error back
        result = {"ok": False, "error": str(exc), "trace": traceback.format_exc()[-2500:]}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
