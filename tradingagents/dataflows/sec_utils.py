"""SEC EDGAR vendor — primary-source company filings (free, no API key).

Grounds the fundamentals analyst in the actual documents companies file with the
SEC (10-K, 10-Q, 8-K, etc.) rather than only aggregator-derived numbers. Two
public EDGAR endpoints are used (ported from the OpenBB SEC provider specs in
``providers/sec/``):

* ``https://www.sec.gov/files/company_tickers.json`` — ticker → CIK map.
* ``https://data.sec.gov/submissions/CIK##########.json`` — a filer's recent
  filings.

EDGAR requires a descriptive ``User-Agent``; requests without one are throttled
or refused. Everything degrades to a clear string rather than raising, so the
analyst run is never aborted by an EDGAR hiccup.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Annotated, Optional

import requests

logger = logging.getLogger(__name__)

_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
_COMPANYFACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"
_HEADERS = {"User-Agent": "tradingagents research contact@tradingagents.ai"}
_TIMEOUT = 15

# Cache the (large-ish) company list for the process lifetime.
_COMPANY_LIST_CACHE: Optional[list] = None
_TICKER_CIK_CACHE: Optional[dict] = None
# Cache raw companyfacts blobs (multi-MB each) briefly so the income/balance/
# cash-flow tabs of one ticker share a single download.
_FACTS_CACHE: dict = {}            # cik -> (ts, facts_json)
_FACTS_TTL = 1800                  # 30 min — filings change at most quarterly


def load_company_list() -> list:
    """Return ``[{symbol, name, cik}, ...]`` for every EDGAR filer, cached.

    Source: SEC's ``company_tickers.json`` (free, no key). Used both to resolve
    CIKs and to power the webapp's instant English ticker/name autosuggest.
    """
    global _COMPANY_LIST_CACHE
    if _COMPANY_LIST_CACHE is not None:
        return _COMPANY_LIST_CACHE

    resp = requests.get(_TICKERS_URL, headers=_HEADERS, timeout=_TIMEOUT)
    resp.raise_for_status()
    raw = resp.json()  # { "0": {cik_str, ticker, title}, ... }
    _COMPANY_LIST_CACHE = [
        {
            "symbol": str(row["ticker"]).upper(),
            "name": str(row.get("title", "")),
            "cik": int(row["cik_str"]),
        }
        for row in raw.values()
        if row.get("ticker")
    ]
    return _COMPANY_LIST_CACHE


def _load_ticker_cik_map() -> dict:
    """Return a ``{TICKER: cik_int}`` map from EDGAR, cached per process."""
    global _TICKER_CIK_CACHE
    if _TICKER_CIK_CACHE is not None:
        return _TICKER_CIK_CACHE
    _TICKER_CIK_CACHE = {c["symbol"]: c["cik"] for c in load_company_list()}
    return _TICKER_CIK_CACHE


def resolve_cik(ticker: str) -> Optional[int]:
    """Resolve a US ticker to its EDGAR CIK, or None if not found."""
    return _load_ticker_cik_map().get(ticker.strip().upper())


def get_sec_filings(
    ticker: Annotated[str, "US-listed ticker symbol, e.g. AAPL"],
    form_type: Annotated[str, "filter by form, e.g. '10-K','10-Q','8-K'; blank = all"] = "",
    limit: Annotated[int, "max number of filings to return"] = 20,
) -> str:
    """List recent SEC EDGAR filings for ``ticker``.

    Optionally filter by ``form_type`` (e.g. ``10-K`` for annual reports). Each
    entry includes the form, filing/report dates, and a direct document URL so
    the analyst can cite the primary source.
    """
    try:
        cik = resolve_cik(ticker)
    except Exception as e:
        return f"Error reaching SEC EDGAR ticker map for '{ticker}': {e}"

    if cik is None:
        return (
            f"No SEC EDGAR CIK found for '{ticker}'. SEC filings cover US-listed "
            f"companies only; non-US tickers won't resolve."
        )

    try:
        time.sleep(0.1)  # be gentle with EDGAR
        resp = requests.get(_SUBMISSIONS_URL.format(cik=cik), headers=_HEADERS, timeout=_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return f"Error retrieving SEC filings for '{ticker}' (CIK {cik}): {e}"

    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    report_dates = recent.get("reportDate", [])
    accessions = recent.get("accessionNumber", [])
    primary_docs = recent.get("primaryDocument", [])
    name = data.get("name", ticker.upper())

    wanted = form_type.strip().upper()
    rows = []
    for i in range(len(forms)):
        if wanted and forms[i].upper() != wanted:
            continue
        acc_nodash = accessions[i].replace("-", "")
        doc = primary_docs[i] if i < len(primary_docs) else ""
        url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}/{doc}"
        rows.append(
            {
                "form": forms[i],
                "filed": dates[i] if i < len(dates) else "",
                "period": report_dates[i] if i < len(report_dates) else "",
                "url": url,
            }
        )
        if len(rows) >= limit:
            break

    if not rows:
        scope = f" of type {wanted}" if wanted else ""
        return f"No SEC filings{scope} found for {name} (CIK {cik})."

    header = (
        f"# SEC EDGAR filings for {name} (CIK {cik})\n"
        f"# Retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    )
    lines = [
        f"- **{r['form']}** filed {r['filed']}"
        + (f" (period {r['period']})" if r["period"] else "")
        + f" — {r['url']}"
        for r in rows
    ]
    return header + "\n".join(lines)


# --------------------------------------------------------------------------- #
# XBRL financial statements (raw, primary-source numbers from company facts)
# --------------------------------------------------------------------------- #
# Each statement is an ordered list of (display label, [candidate us-gaap tags]).
# Companies tag the same concept differently across filers/years, so we try the
# tags in order and take the first that has data. Mirrors how the OpenBB SEC
# provider maps XBRL concepts onto a standardized statement.
_INCOME_ITEMS = [
    ("Total Revenue", ["RevenueFromContractWithCustomerExcludingAssessedTax",
                        "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"]),
    ("Cost of Revenue", ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"]),
    ("Gross Profit", ["GrossProfit"]),
    ("Operating Expenses", ["OperatingExpenses", "CostsAndExpenses"]),
    ("R&D Expense", ["ResearchAndDevelopmentExpense"]),
    ("SG&A Expense", ["SellingGeneralAndAdministrativeExpense"]),
    ("Operating Income", ["OperatingIncomeLoss"]),
    ("Interest Expense", ["InterestExpense", "InterestExpenseNonoperating"]),
    ("Pretax Income", ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
                       "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"]),
    ("Income Tax", ["IncomeTaxExpenseBenefit"]),
    ("Net Income", ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"]),
    ("EPS (Basic)", ["EarningsPerShareBasic"]),
    ("EPS (Diluted)", ["EarningsPerShareDiluted"]),
]
_BALANCE_ITEMS = [
    ("Cash & Equivalents", ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]),
    ("Short-Term Investments", ["ShortTermInvestments", "MarketableSecuritiesCurrent"]),
    ("Total Current Assets", ["AssetsCurrent"]),
    ("Total Assets", ["Assets"]),
    ("Total Current Liabilities", ["LiabilitiesCurrent"]),
    ("Long-Term Debt", ["LongTermDebtNoncurrent", "LongTermDebt"]),
    ("Total Liabilities", ["Liabilities"]),
    ("Retained Earnings", ["RetainedEarningsAccumulatedDeficit"]),
    ("Stockholders' Equity", ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]),
]
_CASHFLOW_ITEMS = [
    ("Operating Cash Flow", ["NetCashProvidedByUsedInOperatingActivities",
                             "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"]),
    ("Capital Expenditure", ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsForCapitalImprovements"]),
    ("Investing Cash Flow", ["NetCashProvidedByUsedInInvestingActivities",
                             "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations"]),
    ("Financing Cash Flow", ["NetCashProvidedByUsedInFinancingActivities",
                             "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"]),
    ("Dividends Paid", ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"]),
    ("Share Repurchases", ["PaymentsForRepurchaseOfCommonStock"]),
    ("Change in Cash", ["CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect",
                        "CashAndCashEquivalentsPeriodIncreaseDecrease"]),
]
_STATEMENTS = {"income": _INCOME_ITEMS, "balance": _BALANCE_ITEMS, "cashflow": _CASHFLOW_ITEMS}
# Balance-sheet line items are point-in-time (instant) facts — no duration to
# filter on — so the annual/quarterly duration test below is skipped for them.
_INSTANT_STATEMENTS = {"balance"}


_FORM_TITLES = {
    "8-K": "Material event filed", "8-K/A": "Material event (amended)",
    "10-K": "Annual report (10-K) filed", "10-Q": "Quarterly report (10-Q) filed",
    "4": "Insider transaction (Form 4)", "SC 13D": "Activist stake disclosed (13D)",
    "SC 13G": "Passive stake disclosed (13G)", "DEF 14A": "Proxy statement filed",
}


def recent_filings(ticker: str, form_type: str = "8-K", limit: int = 10) -> list:
    """Recent EDGAR filings for ``ticker`` as structured news-ready rows.

    Returns ``[{title, form, source, published(ts), link, period}, ...]`` newest
    first — used to fold material filings (8-K events, etc.) into the news feed.
    Empty list on any failure (non-US ticker, EDGAR hiccup).
    """
    from datetime import timezone

    try:
        cik = resolve_cik(ticker)
        if cik is None:
            return []
        time.sleep(0.1)
        resp = requests.get(_SUBMISSIONS_URL.format(cik=cik), headers=_HEADERS, timeout=_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("recent_filings failed for %s: %s", ticker, e)
        return []

    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    report_dates = recent.get("reportDate", [])
    accessions = recent.get("accessionNumber", [])
    primary_docs = recent.get("primaryDocument", [])
    name = data.get("name", ticker.upper())
    sym = ticker.strip().upper()
    wanted = (form_type or "").strip().upper()

    rows = []
    for i in range(len(forms)):
        if wanted and forms[i].upper() != wanted:
            continue
        acc = accessions[i].replace("-", "")
        doc = primary_docs[i] if i < len(primary_docs) else ""
        filed = dates[i] if i < len(dates) else ""
        ts = 0
        try:
            ts = int(datetime.strptime(filed, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
        except (ValueError, TypeError):
            pass
        rows.append({
            "title": f"{name}: {_FORM_TITLES.get(forms[i], forms[i] + ' filed')}",
            "form": forms[i],
            "source": "SEC EDGAR",
            "published": ts,
            "link": f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{doc}",
            "period": report_dates[i] if i < len(report_dates) else "",
            "tickers": [sym],
        })
        if len(rows) >= limit:
            break
    return rows


def _stmt_key(label: str) -> str:
    """A stable snake_case key for a statement row label."""
    k = "".join(ch if ch.isalnum() else "_" for ch in label.lower())
    while "__" in k:
        k = k.replace("__", "_")
    return k.strip("_")


def _company_facts(cik: int) -> dict:
    """Fetch + cache a filer's full XBRL company-facts blob from EDGAR."""
    hit = _FACTS_CACHE.get(cik)
    if hit and (time.time() - hit[0]) < _FACTS_TTL:
        return hit[1]
    time.sleep(0.1)  # be gentle with EDGAR
    resp = requests.get(_COMPANYFACTS_URL.format(cik=cik), headers=_HEADERS, timeout=_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    _FACTS_CACHE[cik] = (time.time(), data)
    return data


def _duration_days(fact: dict) -> Optional[int]:
    """Length in days of a duration fact (None for instant/point-in-time facts)."""
    s, e = fact.get("start"), fact.get("end")
    if not s or not e:
        return None
    try:
        return (datetime.strptime(e, "%Y-%m-%d") - datetime.strptime(s, "%Y-%m-%d")).days
    except (ValueError, TypeError):
        return None


def _pick_value(units: dict, period: str, instant: bool) -> dict:
    """Map ``period_end -> value`` for one concept, filtered to annual/quarterly.

    Picks the right unit (USD, USD/shares for EPS, or shares), then keeps facts
    whose duration matches the requested cadence: ~full year for ``annual``
    (>300 days) and ~one quarter for ``quarter`` (60–135 days). Instant facts
    (balance sheet) skip the duration test. On duplicate period ends the latest
    filed value wins.
    """
    series = units.get("USD") or units.get("USD/shares") or units.get("shares")
    if not series:
        return {}
    out: dict = {}
    for f in series:
        end = f.get("end")
        if not end:
            continue
        if instant:
            # Point-in-time facts have no duration; key on fiscal period instead.
            # Annual = the fiscal-year snapshot (fp "FY" / a 10-K); quarter = any.
            if period == "annual" and f.get("fp") != "FY" and f.get("form") != "10-K":
                continue
        else:
            d = _duration_days(f)
            if d is None:
                continue
            if period == "annual" and d <= 300:
                continue
            if period == "quarter" and not (60 <= d <= 135):
                continue
        # Later-filed values supersede restatements for the same period end.
        prev = out.get(end)
        if prev is None or (f.get("filed", "") >= prev[1]):
            out[end] = (f.get("val"), f.get("filed", ""))
    return {k: v[0] for k, v in out.items()}


def financial_statement(
    ticker: str,
    statement: str = "income",
    period: str = "annual",
    limit: int = 6,
) -> dict:
    """Assemble a raw XBRL financial statement straight from SEC company facts.

    ``statement`` is ``income`` | ``balance`` | ``cashflow``; ``period`` is
    ``annual`` | ``quarter``. Returns a column-per-period table::

        {ticker, name, statement, period, currency, periods:[...end dates...],
         rows:[{label, key, values:[...]}, ...], source:"SEC EDGAR (XBRL)"}

    Every figure is the number the company itself filed — no aggregator in the
    middle. Degrades to ``{error: ...}`` rather than raising.
    """
    sym = (ticker or "").strip().upper()
    stmt = (statement or "income").lower()
    period = "quarter" if str(period).lower().startswith("q") else "annual"
    items = _STATEMENTS.get(stmt)
    if items is None:
        return {"error": f"Unknown statement '{statement}'. Use income|balance|cashflow."}

    cik = resolve_cik(sym)
    if cik is None:
        return {"error": f"No SEC CIK for '{sym}'. SEC statements cover US-listed filers only."}
    try:
        facts = _company_facts(cik)
    except Exception as e:  # noqa: BLE001
        return {"error": f"Could not fetch SEC company facts for {sym}: {e}"}

    gaap = (facts.get("facts") or {}).get("us-gaap") or {}
    instant = stmt in _INSTANT_STATEMENTS

    # Resolve each line item to its period->value map, collecting all period ends.
    resolved = []          # (label, key, {end: val})
    all_ends: set = set()
    for label, tags in items:
        vals: dict = {}
        for tag in tags:
            node = gaap.get(tag)
            if not node:
                continue
            vals = _pick_value(node.get("units") or {}, period, instant)
            if vals:
                break
        resolved.append((label, _stmt_key(label), vals))
        all_ends.update(vals.keys())

    if not all_ends:
        return {"error": f"No XBRL statement data found for {sym} ({stmt})."}

    periods = sorted(all_ends)[-limit:]        # oldest → newest, capped
    rows = [
        {"label": label, "key": key, "values": [vals.get(p) for p in periods]}
        for label, key, vals in resolved
    ]
    return {
        "ticker": sym,
        "name": facts.get("entityName", sym),
        "statement": stmt,
        "period": period,
        "currency": "USD",
        "periods": periods,
        "rows": rows,
        "source": "SEC EDGAR (XBRL)",
    }
