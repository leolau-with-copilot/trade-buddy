"""Unified market calendar — one feed merging three event sources:

* **Curated macro events** — FOMC, CPI, NFP, GDP and other scheduled releases
  with hand-written context (reliable; the free economic-calendar APIs are
  premium-gated).
* **Earnings** — next reported-earnings date for a basket of widely-held names,
  pulled from Yahoo Finance (``yfinance``) and cached.
* **Economic calendar** — Finnhub rows when a (premium) key is available;
  degrades to empty otherwise.

Everything is normalised to ``{date, time, title, type, impact, tickers, desc}``
so the front-end can drop each event onto a month-grid cell.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

# In-process TTL cache (mirrors webapp.whale._cached, kept local to avoid a dep).
import time

_CACHE: Dict[str, tuple] = {}


def _cached(key: str, ttl: float, producer):
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[1] < ttl:
        return hit[0]
    val = producer()
    _CACHE[key] = (val, now)
    return val


# ── Curated macro / policy events ───────────────────────────────────────────
# Scheduled, high-conviction events with real context. Edited a couple of times
# a year; the dates are the official release schedule.
CURATED_EVENTS: List[Dict[str, Any]] = [
    {"date": "2026-06-10", "time": "08:30 ET", "title": "CPI — May", "type": "cpi", "impact": "high",
     "desc": "Core CPI consensus +0.3% MoM. Lands one week before the June FOMC — a hot print locks in a hold; a cool one makes a July cut the base case.", "tickers": ["SPY", "TLT"]},
    {"date": "2026-06-17", "time": "14:00 ET", "title": "FOMC Rate Decision", "type": "fomc", "impact": "high",
     "desc": "Hold at 4.25–4.50% expected, with an updated dot plot. The 2026 dot median sets whether 1 or 2 cuts are signaled for H2.", "tickers": ["SPY", "TLT", "QQQ"]},
    {"date": "2026-06-27", "time": "08:30 ET", "title": "PCE — May", "type": "cpi", "impact": "med",
     "desc": "The Fed's preferred inflation gauge. Core PCE trend confirms or challenges the CPI read.", "tickers": ["SPY", "TLT"],
     "url": "https://www.bea.gov/data/personal-consumption-expenditures-price-index"},
    {"date": "2026-07-02", "time": "08:30 ET", "title": "Non-Farm Payrolls — June", "type": "jobs", "impact": "high",
     "desc": "Consensus ~+170K. Final major labor print before the July FOMC. Unemployment >4.3% would be a meaningful softening signal.", "tickers": ["SPY", "DXY", "TLT"]},
    {"date": "2026-07-14", "time": "08:30 ET", "title": "CPI — June", "type": "cpi", "impact": "high",
     "desc": "Core CPI consensus +0.2–0.3% MoM. Last major data point before the July 29 FOMC; a sub-0.2% core makes a July cut near-certain.", "tickers": ["SPY", "TLT"]},
    {"date": "2026-07-29", "time": "14:00 ET", "title": "FOMC Rate Decision", "type": "fomc", "impact": "high",
     "desc": "Possible first cut to 4.00–4.25% if inflation cooperates (~40% priced). If June CPI surprised low, this is where a cut becomes live.", "tickers": ["SPY", "TLT"]},
    {"date": "2026-07-31", "time": "08:30 ET", "title": "Q2 2026 GDP (Advance)", "type": "gdp", "impact": "high",
     "desc": "Consumer spending and residential investment are the key components; a negative print would immediately price in 2–3 cuts.", "tickers": ["SPY", "TLT"]},
    {"date": "2026-08-07", "time": "08:30 ET", "title": "Non-Farm Payrolls — July", "type": "jobs", "impact": "high",
     "desc": "First labor read after the July FOMC; shapes the September decision.", "tickers": ["SPY", "DXY"]},
    {"date": "2026-08-12", "time": "08:30 ET", "title": "CPI — July", "type": "cpi", "impact": "high",
     "desc": "Inflation trajectory into the late-August Jackson Hole symposium.", "tickers": ["SPY", "TLT"]},
    {"date": "2026-09-16", "time": "14:00 ET", "title": "FOMC Rate Decision", "type": "fomc", "impact": "high",
     "desc": "September meeting with fresh projections; widely watched for the start (or continuation) of the cutting cycle.", "tickers": ["SPY", "TLT", "QQQ"]},
]

# Authoritative source page per event type (for "open the actual site" clicks).
_TYPE_URL = {
    "fomc": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    "cpi": "https://www.bls.gov/cpi/",
    "jobs": "https://www.bls.gov/ces/",
    "gdp": "https://www.bea.gov/data/gdp/gross-domestic-product",
}

# Economic-event title keywords → the agency/source that actually publishes it.
_ECON_KEYWORDS = [
    ("cpi", "https://www.bls.gov/cpi/"),
    ("consumer price", "https://www.bls.gov/cpi/"),
    ("inflation", "https://www.bls.gov/cpi/"),
    ("ppi", "https://www.bls.gov/ppi/"),
    ("producer price", "https://www.bls.gov/ppi/"),
    ("pce", "https://www.bea.gov/data/personal-consumption-expenditures-price-index"),
    ("nonfarm", "https://www.bls.gov/ces/"),
    ("non-farm", "https://www.bls.gov/ces/"),
    ("payroll", "https://www.bls.gov/ces/"),
    ("unemployment", "https://www.bls.gov/cps/"),
    ("jobless claims", "https://oui.doleta.gov/unemploy/claims.asp"),
    ("retail sales", "https://www.census.gov/retail/index.html"),
    ("durable goods", "https://www.census.gov/economic-indicators/"),
    ("housing starts", "https://www.census.gov/construction/nrc/index.html"),
    ("building permits", "https://www.census.gov/construction/nrc/index.html"),
    ("trade balance", "https://www.census.gov/foreign-trade/index.html"),
    ("gdp", "https://www.bea.gov/data/gdp/gross-domestic-product"),
    ("ism", "https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/"),
    ("pmi", "https://www.pmi.spglobal.com/"),
    ("consumer confidence", "https://www.conference-board.org/topics/consumer-confidence"),
    ("consumer sentiment", "https://www.sca.isr.umich.edu/"),
    ("michigan", "https://www.sca.isr.umich.edu/"),
]

# Central-bank home pages, keyed both by issuer keyword and by country code, for
# speeches / policy commentary that has no single release page.
_BANK_URL = {
    "fed": "https://www.federalreserve.gov/newsevents/speeches.htm",
    "fomc": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    "ecb": "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html",
    "lagarde": "https://www.ecb.europa.eu/press/key/html/index.en.html",
    "boe": "https://www.bankofengland.co.uk/news/speeches",
    "bailey": "https://www.bankofengland.co.uk/news/speeches",
    "boj": "https://www.boj.or.jp/en/about/press/index.htm",
    "pboc": "http://www.pbc.gov.cn/en/3688110/index.html",
    "rba": "https://www.rba.gov.au/speeches/",
    "boc": "https://www.bankofcanada.ca/press/speeches/",
    "rbi": "https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx",
    "snb": "https://www.snb.ch/en/the-snb/mandates-goals/monetary-policy",
}
_COUNTRY_BANK = {
    "US": _BANK_URL["fed"], "EU": _BANK_URL["ecb"], "EZ": _BANK_URL["ecb"],
    "GB": _BANK_URL["boe"], "UK": _BANK_URL["boe"], "JP": _BANK_URL["boj"],
    "CN": _BANK_URL["pboc"], "AU": _BANK_URL["rba"], "CA": _BANK_URL["boc"],
    "IN": _BANK_URL["rbi"], "CH": _BANK_URL["snb"],
}


def _event_url(ev: Dict[str, Any]) -> str:
    """Best external source URL for an event — the agency/site that publishes it."""
    if ev.get("url"):
        return ev["url"]
    tks = ev.get("tickers") or []
    if ev.get("type") == "earnings" and tks:
        return f"https://finance.yahoo.com/quote/{tks[0]}"
    if ev.get("type") in _TYPE_URL:
        return _TYPE_URL[ev["type"]]

    title = (ev.get("title") or "").lower()
    # 1) Central-bank business (speeches, rate decisions, minutes, policy) → the
    #    issuer named in the title, else that country's central bank.
    policy = any(w in title for w in (
        "speech", "speaks", "testimony", "rate decision", "interest rate",
        "minutes", "monetary policy", "press conference"))
    if policy:
        for key, url in _BANK_URL.items():
            if key in title:
                return url
        bank = _COUNTRY_BANK.get((ev.get("country") or "").upper())
        if bank:
            return bank
    # 2) Known indicator → its publishing agency.
    for kw, url in _ECON_KEYWORDS:
        if kw in title:
            return url
    # 3) Last resort: a real economic calendar (not a search engine).
    return "https://tradingeconomics.com/calendar"


# Widely-held names whose earnings we surface on the calendar.
EARNINGS_TICKERS = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "AMD",
    "NFLX", "JPM", "V", "WMT", "COST", "PLTR", "COIN", "MSTR", "CRM",
]


def _earnings_event(ticker: str) -> Dict[str, Any] | None:
    """Next earnings date for one ticker via yfinance (light ``.calendar`` read)."""
    try:
        import yfinance as yf
        cal = yf.Ticker(ticker).calendar or {}
        ed = cal.get("Earnings Date")
        if isinstance(ed, (list, tuple)):
            ed = ed[0] if ed else None
        if ed is None:
            return None
        d = ed.strftime("%Y-%m-%d") if hasattr(ed, "strftime") else str(ed)[:10]
        return {"date": d, "time": "", "title": f"{ticker} Earnings", "type": "earnings",
                "impact": "med", "tickers": [ticker],
                "desc": f"{ticker} reports quarterly results."}
    except Exception as exc:  # noqa: BLE001
        logger.debug("earnings(%s) failed: %s", ticker, exc)
        return None


def _earnings_events() -> List[Dict[str, Any]]:
    def _f():
        out: List[Dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=8) as ex:
            futs = [ex.submit(_earnings_event, t) for t in EARNINGS_TICKERS]
            for fut in as_completed(futs):
                ev = fut.result()
                if ev:
                    out.append(ev)
        return out

    return _cached("cal:earnings", 6 * 3600, _f)


def _economic_events() -> List[Dict[str, Any]]:
    """Finnhub economic calendar rows, if a (premium) key is configured."""
    try:
        from webapp import globalmarkets
        rows = (globalmarkets.calendar() or {}).get("rows", []) or []
    except Exception as exc:  # noqa: BLE001
        logger.debug("economic calendar failed: %s", exc)
        return []
    out = []
    for r in rows:
        d = (r.get("date") or "")[:10]
        if not d:
            continue
        out.append({"date": d, "time": r.get("time", ""), "title": r.get("event", ""),
                    "type": "econ", "impact": (r.get("impact") or "low").lower(),
                    "tickers": [], "country": r.get("country", ""),
                    "desc": f"Est. {r.get('estimate', '—')} · Prev. {r.get('prev', '—')}"})
    return out


def unified_calendar() -> Dict[str, Any]:
    """Merged, de-duplicated, date-sorted event list for the calendar page."""
    def _f():
        events: List[Dict[str, Any]] = []
        events.extend(CURATED_EVENTS)
        events.extend(_earnings_events())
        events.extend(_economic_events())
        # De-dupe on (date, title); sort ascending by date then time.
        seen = set()
        deduped = []
        for e in sorted(events, key=lambda x: (x.get("date", ""), x.get("time", ""))):
            k = (e.get("date"), e.get("title"))
            if k in seen:
                continue
            seen.add(k)
            e = {**e, "url": _event_url(e)}
            deduped.append(e)
        return {"events": deduped, "generated": date.today().isoformat()}

    try:
        return _cached("cal:unified", 1800, _f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("unified_calendar failed: %s", exc)
        return {"events": list(CURATED_EVENTS), "generated": date.today().isoformat()}


def prewarm() -> None:
    """Force-refresh the merged calendar into cache (background warmer hook)."""
    _CACHE.pop("cal:unified", None)
    unified_calendar()
