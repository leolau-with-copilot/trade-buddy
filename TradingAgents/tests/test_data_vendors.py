"""Tests for the China (AKShare), smart-money (OpenInsider / Finnhub / Kadoa),
SEC, and macro (FRED) data vendors.

These exercise the pure logic — ticker detection, column normalization, vendor
routing/override, HTML/JSON parsing, and graceful degradation — without hitting
the network.
"""

import os

import pandas as pd
import pytest

from tradingagents.dataflows import interface as I
from tradingagents.dataflows import (
    akshare_utils,
    congress_kadoa_utils,
    finnlp_sources,
    openinsider_utils,
)


# --- AKShare: China ticker detection + normalization ------------------------

@pytest.mark.parametrize("ticker,expected", [
    ("600519", True), ("600519.SH", True), ("600519.SS", True),
    ("000001.SZ", True), ("000001", True), ("300750", True), ("688981", True),
    ("AAPL", False), ("0700.HK", False), ("SPY", False), ("^HSI", False),
    ("", False),
])
def test_is_china_a_share(ticker, expected):
    assert akshare_utils.is_china_a_share(ticker) is expected


def test_to_akshare_code_strips_suffix():
    assert akshare_utils.to_akshare_code("600519.SH") == "600519"
    assert akshare_utils.to_akshare_code("000001") == "000001"
    with pytest.raises(ValueError):
        akshare_utils.to_akshare_code("AAPL")


def test_normalize_akshare_chinese_headers():
    raw = pd.DataFrame({
        "日期": ["2024-01-02"], "股票代码": ["600519"], "开盘": [1685.0],
        "收盘": [1700.0], "最高": [1710.0], "最低": [1680.0], "成交量": [30000],
        "成交额": [5e9], "振幅": [1.8], "涨跌幅": [0.9], "涨跌额": [15.0], "换手率": [0.24],
    })
    out = akshare_utils._normalize_akshare_df(raw)
    assert list(out.columns) == ["Date", "Open", "High", "Low", "Close", "Volume"]
    assert out.iloc[0]["Close"] == 1700.0


def test_normalize_akshare_positional_fallback():
    # Unknown (non-Chinese) headers fall back to positional mapping by order.
    raw = pd.DataFrame([[20240102, 1.0, 2.0, 3.0, 0.5, 100]],
                       columns=["d", "o", "c", "h", "l", "v"])
    out = akshare_utils._normalize_akshare_df(raw)
    assert list(out.columns) == ["Date", "Open", "High", "Low", "Close", "Volume"]


# --- routing: China auto-override + exception fallback ----------------------

def test_china_symbol_routes_to_akshare():
    assert I._auto_vendor_override("get_stock_data", ("600519.SH",)) == ["akshare"]
    assert I._auto_vendor_override("get_indicators", ("000001", "rsi")) == ["akshare"]


def test_non_china_symbol_no_override():
    assert I._auto_vendor_override("get_stock_data", ("AAPL",)) == []
    # Override only applies to symbol-first price/indicator methods.
    assert I._auto_vendor_override("get_fundamentals", ("600519",)) == []


def test_router_falls_through_on_exception(monkeypatch):
    calls = []

    def boom(*a, **k):
        calls.append("boom")
        raise RuntimeError("vendor down")

    def ok(*a, **k):
        calls.append("ok")
        return "RESULT"

    monkeypatch.setitem(I.VENDOR_METHODS["get_news"], "yfinance", boom)
    monkeypatch.setitem(I.VENDOR_METHODS["get_news"], "finnhub", ok)
    monkeypatch.setattr(I, "get_vendor", lambda *a, **k: "yfinance,finnhub")

    assert I.route_to_vendor("get_news", "AAPL", "2024-01-01", "2024-01-10") == "RESULT"
    assert calls == ["boom", "ok"]


def test_router_raises_when_all_vendors_fail(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("down")

    monkeypatch.setitem(I.VENDOR_METHODS["get_news"], "yfinance", boom)
    monkeypatch.setitem(I.VENDOR_METHODS["get_news"], "finnhub", boom)
    monkeypatch.setattr(I, "get_vendor", lambda *a, **k: "yfinance,finnhub")

    with pytest.raises(RuntimeError, match="All vendors failed"):
        I.route_to_vendor("get_news", "AAPL", "2024-01-01", "2024-01-10")


# --- categories are registered + configured ---------------------------------

def test_new_methods_registered():
    for method in ["get_economic_indicator", "get_macro_snapshot", "get_sec_filings"]:
        assert method in I.VENDOR_METHODS
        assert I.get_category_for_method(method)  # must belong to a category
    assert "akshare" in I.VENDOR_METHODS["get_stock_data"]
    assert "yfinance" in I.VENDOR_METHODS["get_fundamentals"]


def test_retired_vendors_fully_removed():
    # FMP, Quiver, and CapitolTrades were retired in favour of keyless
    # OpenInsider (corporate) and Kadoa (congressional) sources.
    for dead in ("fmp", "quiver", "capitoltrades"):
        assert dead not in I.VENDOR_LIST, f"{dead} still in VENDOR_LIST"
        for method, vendors in I.VENDOR_METHODS.items():
            assert dead not in vendors, f"{method} still references {dead}"


# --- smart money: OpenInsider (corporate) + Kadoa (congress) ----------------

def test_smart_money_methods_registered():
    assert I.get_category_for_method("get_insider_transactions") == "smart_money"
    assert I.get_category_for_method("get_congress_trading") == "smart_money"
    assert list(I.VENDOR_METHODS["get_congress_trading"]) == ["kadoa"]
    assert list(I.VENDOR_METHODS["get_insider_transactions"]) == ["openinsider", "finnhub", "yfinance"]


def test_smart_money_vendor_chains():
    from tradingagents.dataflows.config import set_config
    from tradingagents.default_config import DEFAULT_CONFIG
    import copy
    set_config(copy.deepcopy(DEFAULT_CONFIG))
    assert I.get_vendor("smart_money", "get_insider_transactions") == "openinsider,finnhub,yfinance"
    assert I.get_vendor("smart_money", "get_congress_trading") == "kadoa"


# --- Kadoa STOCK Act dataset parsing (no network) ---------------------------

_KADOA_TICKER = {"ticker": "AAPL", "trades": [
    {"filer_name": "David Taylor", "party": "R", "chamber": "house", "branch": "congress",
     "ticker": "AAPL", "asset_name": "Apple Inc", "transaction_type": "Sale (Full)",
     "amount_range_label": "$1,001 - $15,000", "transaction_date": "2026-05-15",
     "filing_date": "2026-05-28", "is_late": 0},
    {"filer_name": "Jane Senator", "party": "D", "chamber": "senate", "branch": "congress",
     "ticker": "AAPL", "asset_name": "Apple Inc", "transaction_type": "Purchase",
     "amount_range_label": "$15,001 - $50,000", "transaction_date": "2026-04-01",
     "filing_date": "2026-06-01", "is_late": 1},
    {"filer_name": "Exec Official", "agency": "Treasury", "branch": "executive", "chamber": None,
     "ticker": "MSFT", "transaction_type": "Purchase", "transaction_date": "2026-03-01",
     "filing_date": "2026-03-20", "is_late": 0},
]}


def test_kadoa_parse_filter_and_normalize():
    rows = congress_kadoa_utils.parse_kadoa_trades(_KADOA_TICKER, symbol="AAPL")
    assert [r["symbol"] for r in rows] == ["AAPL", "AAPL"]   # MSFT row filtered out
    assert rows[0]["date"] == "2026-05-15"                   # sorted newest-first
    assert rows[0]["chamber"] == "House" and rows[0]["side"] == "sell"
    assert rows[1]["chamber"] == "Senate" and rows[1]["side"] == "buy" and rows[1]["is_late"]


def test_kadoa_parse_executive_branch():
    rows = congress_kadoa_utils.parse_kadoa_trades(_KADOA_TICKER["trades"], symbol="MSFT")
    assert len(rows) == 1
    assert rows[0]["chamber"] == "Executive" and rows[0]["name"] == "Exec Official"


# --- Finnhub insider JSON parsing (no network) ------------------------------

_FINNHUB_INSIDER = {"data": [
    {"name": "TIM COOK", "change": 10000, "transactionCode": "P",
     "transactionPrice": 195.0, "transactionDate": "2026-05-18",
     "filingDate": "2026-05-20", "symbol": "AAPL"},
    {"name": "JANE DOE", "change": -2000, "transactionCode": "S",
     "transactionPrice": 196.0, "transactionDate": "2026-05-17",
     "filingDate": "2026-05-19", "symbol": "AAPL"},
    {"name": "GIFTER", "change": -65000, "transactionCode": "G",
     "transactionPrice": 0, "transactionDate": "2026-05-27",
     "filingDate": "2026-05-29", "symbol": "AAPL"},
]}


def test_finnhub_insider_parse():
    rows = finnlp_sources.parse_finnhub_insider(_FINNHUB_INSIDER)
    assert len(rows) == 3
    assert rows[0]["side"] == "buy" and rows[0]["shares"] == 10000
    assert rows[0]["name"] == "Tim Cook"      # title-cased
    assert rows[0]["value"] == round(10000 * 195.0)
    assert rows[1]["side"] == "sell"
    assert rows[2]["side"] == "other"          # gift code 'G' is not buy/sell


# --- OpenInsider HTML parsing (no network) ----------------------------------

_OPENINSIDER_HTML = """
<table class="tinytable">
  <thead><tr>
    <th>X</th><th>Filing Date</th><th>Trade Date</th><th>Ticker</th>
    <th>Company Name</th><th>Insider Name</th><th>Title</th><th>Trade Type</th>
    <th>Price</th><th>Qty</th><th>Owned</th><th>&Delta;Own</th><th>Value</th>
  </tr></thead>
  <tbody>
    <tr><td></td><td>2026-05-20</td><td>2026-05-18</td><td>AAPL</td>
        <td>Apple Inc</td><td>Tim Cook</td><td>CEO</td><td>P - Purchase</td>
        <td>$195.00</td><td>10,000</td><td>50,000</td><td>+25%</td><td>+$1,950,000</td></tr>
    <tr><td></td><td>2026-05-19</td><td>2026-05-17</td><td>AAPL</td>
        <td>Apple Inc</td><td>Jane Doe</td><td>Dir</td><td>S - Sale</td>
        <td>$196.00</td><td>2,000</td><td>8,000</td><td>-20%</td><td>-$392,000</td></tr>
  </tbody>
</table>
"""


def test_openinsider_parse_rows():
    rows = openinsider_utils.parse_openinsider_html(_OPENINSIDER_HTML)
    assert len(rows) == 2
    buy = rows[0]
    assert buy["name"] == "Tim Cook"
    assert buy["role"] == "CEO"
    assert buy["side"] == "buy"
    assert buy["shares"] == "10,000"
    assert rows[1]["side"] == "sell"


def test_openinsider_parse_empty_when_no_table():
    assert openinsider_utils.parse_openinsider_html("<html><body>nope</body></html>") == []
