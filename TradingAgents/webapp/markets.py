"""Market metadata + ticker search scoped by country / exchange.

Powers the webapp's country → exchange → stock drilldown:

* :data:`COUNTRY_EXCHANGES` — a curated country → exchanges map. Each exchange
  carries the Yahoo symbol ``suffix`` (so a bare local code becomes a chart-ready
  ticker) and a ``backend`` (``yahoo`` for global search, ``akshare`` for China
  A-shares whose names/codes Yahoo search handles poorly).
* :func:`search_exchange` — autocomplete scoped to one exchange.
* :func:`china_a_share_suffix` — map a 6-digit A-share code to ``.SS`` / ``.SZ``.

China A-share names are looked up from AKShare's full code↔name table, cached to
disk so the (~5k row) list is fetched at most once per day.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# country -> list of exchanges. ``suffix`` is the Yahoo-Finance ticker suffix
# (empty for US); ``backend`` selects the autocomplete source.
COUNTRY_EXCHANGES: Dict[str, List[dict]] = {
    "United States": [
        {"code": "US", "label": "NYSE / NASDAQ / AMEX", "suffix": "", "backend": "local"},
    ],
    "China": [
        {"code": "SSE", "label": "Shanghai (SSE)", "suffix": ".SS", "backend": "akshare"},
        {"code": "SZSE", "label": "Shenzhen (SZSE)", "suffix": ".SZ", "backend": "akshare"},
    ],
    "Hong Kong": [
        {"code": "HKEX", "label": "Hong Kong (HKEX)", "suffix": ".HK", "backend": "yahoo"},
    ],
    "Japan": [
        {"code": "TSE", "label": "Tokyo (TSE)", "suffix": ".T", "backend": "yahoo"},
    ],
    "United Kingdom": [
        {"code": "LSE", "label": "London (LSE)", "suffix": ".L", "backend": "yahoo"},
    ],
    "Canada": [
        {"code": "TSX", "label": "Toronto (TSX)", "suffix": ".TO", "backend": "yahoo"},
        {"code": "TSXV", "label": "TSX Venture", "suffix": ".V", "backend": "yahoo"},
    ],
    "Australia": [
        {"code": "ASX", "label": "Australia (ASX)", "suffix": ".AX", "backend": "yahoo"},
    ],
    "India": [
        {"code": "NSE", "label": "India (NSE)", "suffix": ".NS", "backend": "yahoo"},
        {"code": "BSE", "label": "India (BSE)", "suffix": ".BO", "backend": "yahoo"},
    ],
    "Germany": [
        {"code": "XETRA", "label": "Germany (XETRA)", "suffix": ".DE", "backend": "yahoo"},
    ],
    "France": [
        {"code": "PAR", "label": "Euronext Paris", "suffix": ".PA", "backend": "yahoo"},
    ],
    "South Korea": [
        {"code": "KRX", "label": "Korea (KOSPI)", "suffix": ".KS", "backend": "yahoo"},
        {"code": "KOSDAQ", "label": "Korea (KOSDAQ)", "suffix": ".KQ", "backend": "yahoo"},
    ],
    "Taiwan": [
        {"code": "TWSE", "label": "Taiwan (TWSE)", "suffix": ".TW", "backend": "yahoo"},
    ],
    "Switzerland": [
        {"code": "SIX", "label": "Switzerland (SIX)", "suffix": ".SW", "backend": "yahoo"},
    ],
    "Brazil": [
        {"code": "B3", "label": "Brazil (B3)", "suffix": ".SA", "backend": "yahoo"},
    ],
}

# Flat code -> exchange-dict lookup for the search endpoint.
EXCHANGE_BY_CODE: Dict[str, dict] = {
    ex["code"]: {**ex, "country": country}
    for country, exchanges in COUNTRY_EXCHANGES.items()
    for ex in exchanges
}


def china_a_share_suffix(code: str) -> str:
    """Return ``.SS`` (Shanghai) or ``.SZ`` (Shenzhen) for a 6-digit A-share code.

    Boards: 60/68/9 → Shanghai; 00/30/20/002 → Shenzhen (default).
    """
    code = code.strip()
    if code[:2] in {"60", "68"} or code[:1] == "9":
        return ".SS"
    return ".SZ"


# --- China A-share name table (AKShare), cached to disk ---------------------

_CHINA_LIST_CACHE: Optional[list] = None
_CHINA_LIST_DAY: Optional[str] = None


def _china_cache_path() -> str:
    from tradingagents.dataflows.config import get_config

    cache_dir = get_config().get("data_cache_dir", ".")
    os.makedirs(cache_dir, exist_ok=True)
    return os.path.join(cache_dir, "akshare-a-share-list.csv")


def _load_china_list() -> list:
    """Return ``[{symbol, name, exchange}, ...]`` for every A-share, cached daily."""
    global _CHINA_LIST_CACHE, _CHINA_LIST_DAY
    today = time.strftime("%Y-%m-%d")
    if _CHINA_LIST_CACHE is not None and _CHINA_LIST_DAY == today:
        return _CHINA_LIST_CACHE

    import pandas as pd

    path = _china_cache_path()
    df = None
    if os.path.exists(path) and time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(path))) == today:
        try:
            df = pd.read_csv(path, dtype={"code": str})
        except Exception:  # noqa: BLE001 — corrupt cache, refetch
            df = None

    if df is None:
        import akshare as ak

        df = ak.stock_info_a_code_name()  # columns: code, name
        df["code"] = df["code"].astype(str).str.zfill(6)
        df.to_csv(path, index=False, encoding="utf-8")

    rows = []
    for _, r in df.iterrows():
        code = str(r["code"]).zfill(6)
        suffix = china_a_share_suffix(code)
        rows.append({
            "symbol": f"{code}{suffix}",
            "name": str(r["name"]),
            "exchange": "Shanghai" if suffix == ".SS" else "Shenzhen",
        })

    _CHINA_LIST_CACHE, _CHINA_LIST_DAY = rows, today
    return rows


def _search_china(query: str, exchange_code: str, limit: int) -> List[dict]:
    """Filter the A-share list by code prefix or name substring, scoped to one board."""
    try:
        rows = _load_china_list()
    except Exception as exc:  # noqa: BLE001 — AKShare unreachable; degrade gracefully
        logger.warning("AKShare A-share list unavailable: %s", exc)
        return []

    want_suffix = ".SS" if exchange_code == "SSE" else ".SZ"
    q = query.strip().lower()
    out = []
    for r in rows:
        if not r["symbol"].endswith(want_suffix):
            continue
        code = r["symbol"].split(".")[0]
        if code.startswith(q) or q in r["name"].lower():
            out.append({**r, "type": "EQUITY"})
            if len(out) >= limit:
                break
    return out


def search_china_all(query: str, limit: int = 10) -> List[dict]:
    """Search the full A-share list (both boards) by code or Chinese/English name.

    Yahoo's search endpoint returns nothing for Chinese-language queries, so when
    the user types a Chinese name in the global ("All") search we fall back to the
    AKShare A-share table here, which carries the Chinese names.
    """
    try:
        rows = _load_china_list()
    except Exception as exc:  # noqa: BLE001 — AKShare unreachable; degrade gracefully
        logger.warning("AKShare A-share list unavailable: %s", exc)
        return []
    q = query.strip().lower()
    out = []
    for r in rows:
        code = r["symbol"].split(".")[0]
        if code.startswith(q) or q in r["name"].lower():
            out.append({**r, "type": "EQUITY"})
            if len(out) >= limit:
                break
    return out


def _search_yahoo(query: str, exchange: dict, limit: int) -> List[dict]:
    """Yahoo search, scoped to one exchange by symbol suffix.

    Non-US exchanges: keep results whose symbol carries the exchange suffix, and
    synthesize a direct ``CODE+suffix`` hit so a bare local code always resolves.
    US: keep suffix-less symbols (NYSE/NASDAQ/AMEX).
    """
    import requests

    suffix = exchange["suffix"]
    results: List[dict] = []
    try:
        resp = requests.get(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": query, "quotesCount": 15, "newsCount": 0},
            headers={"User-Agent": "Mozilla/5.0 (TradingAgents)"},
            timeout=8,
        )
        resp.raise_for_status()
        quotes = resp.json().get("quotes", [])
    except Exception as exc:  # noqa: BLE001
        logger.warning("yahoo search failed for %r: %s", query, exc)
        quotes = []

    for item in quotes:
        symbol = item.get("symbol")
        if not symbol:
            continue
        if suffix:
            if not symbol.upper().endswith(suffix.upper()):
                continue
        else:
            # US: drop any exchange-suffixed symbol (keep plain tickers).
            if "." in symbol:
                continue
        results.append({
            "symbol": symbol,
            "name": item.get("shortname") or item.get("longname") or "",
            "exchange": item.get("exchDisp") or item.get("exchange") or "",
            "type": item.get("quoteType") or "",
        })

    # Synthesize a bare-code hit (e.g. "7203" → "7203.T") if not already present.
    if suffix and query and query.replace(".", "").isalnum():
        synth = f"{query.upper().split('.')[0]}{suffix}"
        if not any(r["symbol"].upper() == synth.upper() for r in results):
            results.insert(0, {"symbol": synth, "name": "", "exchange": exchange["label"], "type": ""})

    return results[:limit]


def us_symbol_list() -> List[dict]:
    """Return ``[{symbol, name}, ...]`` for all US-listed companies (SEC), cached.

    Powers instant English autosuggest by ticker or company name. Degrades to an
    empty list if EDGAR is unreachable.
    """
    try:
        from tradingagents.dataflows.sec_utils import load_company_list

        return [{"symbol": c["symbol"], "name": c["name"]} for c in load_company_list()]
    except Exception as exc:  # noqa: BLE001
        logger.warning("US symbol list unavailable: %s", exc)
        return []


def rank_local_matches(query: str, rows: List[dict], limit: int = 10) -> List[dict]:
    """Rank ``rows`` ({symbol, name}) against ``query`` by ticker/name relevance.

    Order: exact ticker > ticker prefix > name word-prefix > name substring.
    Matches on both the symbol (e.g. "aapl") and the name (e.g. "apple").
    """
    q = query.strip().lower()
    if not q:
        return []

    exact, sym_prefix, name_prefix, name_sub = [], [], [], []
    for r in rows:
        sym = r["symbol"].lower()
        name = (r["name"] or "").lower()
        if sym == q:
            exact.append(r)
        elif sym.startswith(q):
            sym_prefix.append(r)
        elif name.startswith(q) or any(w.startswith(q) for w in name.split()):
            name_prefix.append(r)
        elif q in sym or q in name:
            name_sub.append(r)

    # Shorter tickers first within the prefix tier (AA before AAPL for "aa").
    sym_prefix.sort(key=lambda r: len(r["symbol"]))
    ranked = exact + sym_prefix + name_prefix + name_sub
    return [{**r, "exchange": "US", "type": "EQUITY"} for r in ranked[:limit]]


def search_exchange(query: str, exchange_code: str, limit: int = 10) -> List[dict]:
    """Autocomplete ``query`` scoped to ``exchange_code``.

    Routes China boards to the AKShare-backed list and everything else to Yahoo.
    Returns ``[{symbol, name, exchange, type}, ...]``.
    """
    exchange = EXCHANGE_BY_CODE.get(exchange_code)
    if exchange is None:
        return []
    if exchange["backend"] == "akshare":
        return _search_china(query, exchange_code, limit)
    if exchange["backend"] == "local":
        # Instant English autosuggest by ticker or name, with Yahoo as a backstop.
        local = rank_local_matches(query, us_symbol_list(), limit)
        return local or _search_yahoo(query, exchange, limit)
    return _search_yahoo(query, exchange, limit)
