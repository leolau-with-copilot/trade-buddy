"""Quote header, key technical signals, and AI insights for the dashboard.

All three read the same OHLCV history (yfinance for most tickers, AKShare for
China A-shares) so a single fetch powers the price stats, the mechanical signal
read, and the trend/support/resistance insights. Everything degrades to nulls
rather than raising, so the dashboard always renders.

The mechanical signals here are *instant* and deterministic — distinct from the
agent pipeline's discussed rating (``/api/analyze``), which is the authoritative
verdict. The dashboard shows these as a fast baseline and overlays the agent
consensus once a full analysis runs.
"""

from __future__ import annotations

import logging
import time
from typing import Dict, List, Optional

import pandas as pd

logger = logging.getLogger(__name__)

# Cache slow yfinance .info lookups (name/sector/PE) briefly.
_INFO_CACHE: Dict[str, dict] = {}
_INFO_TTL = 900


def _ohlcv(ticker: str) -> pd.DataFrame:
    """Load daily OHLCV via the right vendor (AKShare for China, else yfinance)."""
    from tradingagents.dataflows.akshare_utils import is_china_a_share, load_ohlcv_akshare
    from tradingagents.dataflows.stockstats_utils import load_ohlcv

    today = time.strftime("%Y-%m-%d")
    if is_china_a_share(ticker):
        return load_ohlcv_akshare(ticker, today)
    return load_ohlcv(ticker, today)


def _slow_info(ticker: str) -> dict:
    """Company name/sector/PE from yfinance .info, cached (slow, rate-limited)."""
    now = time.time()
    hit = _INFO_CACHE.get(ticker.upper())
    if hit and now - hit["ts"] < _INFO_TTL:
        return hit["data"]
    data = {}
    try:
        import yfinance as yf

        info = yf.Ticker(ticker).info or {}
        data = {
            "name": info.get("longName") or info.get("shortName") or "",
            "sector": info.get("sector") or info.get("industry") or "",
            "pe": info.get("trailingPE"),
            "industry_pe": info.get("forwardPE"),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("slow info for %s failed: %s", ticker, exc)
    _INFO_CACHE[ticker.upper()] = {"ts": now, "data": data}
    return data


def quote(ticker: str) -> dict:
    """Quote header: price, OHLC, volume, market cap, 52w range, PE, change windows."""
    out: dict = {"symbol": ticker.upper()}
    try:
        import yfinance as yf

        fi = yf.Ticker(ticker).fast_info
        last = fi.get("lastPrice")
        prev = fi.get("previousClose") or fi.get("regularMarketPreviousClose")
        out.update({
            "price": last,
            "prev_close": prev,
            "open": fi.get("open"),
            "day_high": fi.get("dayHigh"),
            "day_low": fi.get("dayLow"),
            "volume": fi.get("lastVolume"),
            "market_cap": fi.get("marketCap"),
            "week52_high": fi.get("yearHigh"),
            "week52_low": fi.get("yearLow"),
            "change": (last - prev) if (last and prev) else None,
            "change_pct": ((last - prev) / prev * 100.0) if (last and prev) else None,
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning("fast_info for %s failed: %s", ticker, exc)

    # China A-shares: yfinance fast_info is often empty — fill from AKShare bars.
    if not out.get("price"):
        try:
            df = _ohlcv(ticker)
            if not df.empty:
                last_row = df.iloc[-1]
                prev_row = df.iloc[-2] if len(df) >= 2 else last_row
                out.update({
                    "price": float(last_row["Close"]),
                    "prev_close": float(prev_row["Close"]),
                    "open": float(last_row["Open"]),
                    "day_high": float(last_row["High"]),
                    "day_low": float(last_row["Low"]),
                    "volume": int(last_row["Volume"]),
                    "week52_high": float(df["High"].tail(252).max()),
                    "week52_low": float(df["Low"].tail(252).min()),
                    "change": float(last_row["Close"] - prev_row["Close"]),
                    "change_pct": float((last_row["Close"] - prev_row["Close"]) / prev_row["Close"] * 100.0),
                })
        except Exception as exc:  # noqa: BLE001
            logger.warning("ohlcv quote fallback for %s failed: %s", ticker, exc)

    # Multi-window change (1D / 5D / 1M) from history.
    try:
        df = _ohlcv(ticker)
        closes = df["Close"].tolist()
        def _chg(n):
            if len(closes) > n and closes[-1 - n]:
                return (closes[-1] - closes[-1 - n]) / closes[-1 - n] * 100.0
            return None
        out["change_1d"] = out.get("change_pct")
        out["change_5d"] = _chg(5)
        out["change_1m"] = _chg(21)
    except Exception:  # noqa: BLE001
        out.setdefault("change_5d", None); out.setdefault("change_1m", None)

    out.update(_slow_info(ticker))
    return out


def _wrapped(ticker: str):
    """Return a stockstats-wrapped frame, or None."""
    from stockstats import wrap

    df = _ohlcv(ticker)
    if df is None or df.empty:
        return None
    return wrap(df.copy())


def signals(ticker: str) -> List[dict]:
    """Instant mechanical key signals from indicators.

    Returns ``[{label, value, verdict}]`` with verdict in
    {bullish, bearish, neutral}. Deterministic — no LLM.
    """
    df = _wrapped(ticker)
    if df is None:
        return []
    out: List[dict] = []
    try:
        close = float(df["close"].iloc[-1])
        ma20 = float(df["close_20_sma"].iloc[-1])
        ma60 = float(df["close_60_sma"].iloc[-1])
        above = close > ma20 and close > ma60
        out.append({
            "label": "Price vs MA20 / MA60",
            "value": f"{close:.2f} vs {ma20:.2f} / {ma60:.2f}",
            "verdict": "bullish" if above else ("bearish" if close < ma20 and close < ma60 else "neutral"),
        })
    except Exception:  # noqa: BLE001
        pass
    try:
        vol = float(df["volume"].iloc[-1])
        vol_avg = float(df["volume"].tail(20).mean())
        out.append({
            "label": "Volume vs 20-day avg",
            "value": f"{vol:,.0f} vs {vol_avg:,.0f}",
            "verdict": "bullish" if vol > vol_avg else "neutral",
        })
    except Exception:  # noqa: BLE001
        pass
    try:
        rsi = float(df["rsi_14"].iloc[-1])
        verdict = "neutral"
        if rsi >= 70: verdict = "bearish"
        elif rsi <= 30: verdict = "bullish"
        out.append({"label": "RSI (14)", "value": f"{rsi:.1f}", "verdict": verdict})
    except Exception:  # noqa: BLE001
        pass
    try:
        macd = float(df["macd"].iloc[-1]); macds = float(df["macds"].iloc[-1])
        out.append({
            "label": "MACD signal",
            "value": "Bullish crossover" if macd > macds else "Bearish crossover",
            "verdict": "bullish" if macd > macds else "bearish",
        })
    except Exception:  # noqa: BLE001
        pass
    pe = _slow_info(ticker).get("pe")
    if pe:
        out.append({"label": "P/E ratio", "value": f"{pe:.2f}", "verdict": "neutral"})
    return out


def consensus_from_signals(sigs: List[dict]) -> dict:
    """Quick mechanical bull/neutral/bear tally → a baseline gauge value."""
    b = sum(1 for s in sigs if s["verdict"] == "bullish")
    n = sum(1 for s in sigs if s["verdict"] == "neutral")
    r = sum(1 for s in sigs if s["verdict"] == "bearish")
    total = max(1, b + n + r)
    score = (b - r) / total  # -1..1
    pct = round((score + 1) / 2 * 100)  # 0..100
    if pct >= 66: label = "Bullish"
    elif pct <= 40: label = "Bearish"
    else: label = "Neutral"
    return {"pct": pct, "label": label, "bullish": b, "neutral": n, "bearish": r}


def insights(ticker: str) -> dict:
    """Trend / support / resistance / outlook from price action and MAs."""
    df = _wrapped(ticker)
    if df is None:
        return {"trend": None, "support": None, "resistance": None,
                "outlook": None, "confidence": None}
    close = float(df["close"].iloc[-1])
    ma20 = float(df["close_20_sma"].iloc[-1])
    ma60 = float(df["close_60_sma"].iloc[-1])
    recent = df.tail(60)
    support = float(recent["low"].min())
    resistance = float(recent["high"].max())
    try:
        rsi = float(df["rsi_14"].iloc[-1])
    except Exception:  # noqa: BLE001
        rsi = 50.0

    bullish = close > ma20 and close > ma60
    bearish = close < ma20 and close < ma60
    trend = "Bullish" if bullish else ("Bearish" if bearish else "Mixed")
    if bullish and rsi < 70:
        outlook, conf = "Positive", 0.78
    elif bearish and rsi > 30:
        outlook, conf = "Negative", 0.72
    else:
        outlook, conf = "Neutral", 0.55

    trend_note = (
        f"Price is {'above' if bullish else 'below' if bearish else 'around'} "
        f"MA20 and MA60"
        + (" with strong momentum." if bullish else "." )
    )
    return {
        "trend": trend,
        "trend_note": trend_note,
        "support": round(support, 2),
        "support_note": "Recent 60-day swing low / volume support.",
        "resistance": round(resistance, 2),
        "resistance_note": "Recent 60-day swing high / range ceiling.",
        "outlook": outlook,
        "confidence": conf,
    }
