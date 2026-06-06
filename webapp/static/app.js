"use strict";

// --------------------------------------------------------------------------- //
// Plotly line charts (OpenBB-style) — shared by the news indices chart, the
// economy click-through, etc. One helper keeps the dark theme consistent.
// --------------------------------------------------------------------------- //
const PLOT_COLORS = ["#3b82f6", "#22d3ee", "#f59e0b", "#a78bfa", "#34d399"];

// Dark, gridded Plotly layout tuned to the terminal look (thin axes, muted
// gridlines, transparent paper so the card background shows through).
function _plotLayout(opts) {
  opts = opts || {};
  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    margin: { l: opts.left != null ? opts.left : 48, r: 12, t: 8, b: 32 },
    font: { color: "#9aa4b2", size: 11, family: "Inter, system-ui, sans-serif" },
    showlegend: false,
    hovermode: "x unified",
    xaxis: {
      type: opts.xtype || "date",
      gridcolor: "rgba(255,255,255,0.04)",
      zeroline: false,
      linecolor: "rgba(255,255,255,0.10)",
      tickformat: opts.xtickformat,
      fixedrange: true,
      automargin: true,   // grow the margin to fit (multi-row) tick labels
      nticks: opts.xnticks || 7,
    },
    yaxis: {
      gridcolor: "rgba(255,255,255,0.06)",
      zeroline: opts.zeroline || false,
      zerolinecolor: "rgba(255,255,255,0.18)",
      ticksuffix: opts.ysuffix || "",
      tickprefix: opts.yprefix || "",
      fixedrange: true,
      automargin: true,
    },
  };
}

const _PLOT_CONFIG = { displayModeBar: false, responsive: true };

// Draw multi-series lines. `series` = [{name, x:[...], y:[...], color?, fill?}].
function plotLines(elId, series, opts) {
  const el = typeof elId === "string" ? document.getElementById(elId) : elId;
  if (!el || typeof Plotly === "undefined") return;
  opts = opts || {};
  const traces = (series || []).map((s, i) => ({
    type: "scatter",
    mode: "lines",
    name: s.name,
    x: s.x,
    y: s.y,
    line: { color: s.color || PLOT_COLORS[i % PLOT_COLORS.length], width: s.width || 2, shape: "spline", smoothing: 0.6 },
    fill: s.fill ? "tozeroy" : "none",
    fillcolor: s.fillcolor || "rgba(59,130,246,0.10)",
    hovertemplate: (opts.yprefix || "") + "%{y:.2f}" + (opts.ysuffix || "") + "<extra>" + (s.name || "") + "</extra>",
  }));
  Plotly.react(el, traces, _plotLayout(opts), _PLOT_CONFIG);
}

// --------------------------------------------------------------------------- //
// State
// --------------------------------------------------------------------------- //
let currentTicker = null;
let currentRange = "3m";
let sse = null;

// Chart state
let _chart = null;
let _lastPriceData = null;
const _indPanes = {};  // name → paneId (or "candle_pane" for overlays)

// Built-in KlineCharts indicator catalog
const IND_CATALOG = [
  { name: "MA",   label: "Moving Average",          overlay: true  },
  { name: "EMA",  label: "Exp. Moving Average",     overlay: true  },
  { name: "SMA",  label: "Simple Moving Average",   overlay: true  },
  { name: "BOLL", label: "Bollinger Bands",         overlay: true  },
  { name: "SAR",  label: "Parabolic SAR",           overlay: true  },
  { name: "BBI",  label: "Bull & Bear Index",       overlay: true  },
  { name: "MACD", label: "MACD",                    overlay: false },
  { name: "KDJ",  label: "KDJ",                     overlay: false },
  { name: "RSI",  label: "RSI",                     overlay: false },
  { name: "CCI",  label: "Commodity Channel Index", overlay: false },
  { name: "DMI",  label: "Directional Movement",    overlay: false },
  { name: "WR",   label: "Williams %R",             overlay: false },
  { name: "BRAR", label: "BRAR",                    overlay: false },
  { name: "MTM",  label: "Momentum",                overlay: false },
  { name: "OBV",  label: "On Balance Volume",       overlay: false },
  { name: "VR",   label: "Volume Ratio",            overlay: false },
  { name: "ROC",  label: "Rate of Change",          overlay: false },
  { name: "PSY",  label: "Psychological Line",      overlay: false },
  { name: "TRIX", label: "Triple EMA",              overlay: false },
  { name: "EMV",  label: "Ease of Movement",        overlay: false },
  { name: "AO",   label: "Awesome Oscillator",      overlay: false },
  { name: "DPO",  label: "Detrended Price Osc.",    overlay: false },
  { name: "BIAS", label: "BIAS",                    overlay: false },
  { name: "VOL",  label: "Volume",                  overlay: false },
  { name: "DMA",  label: "DMA",                     overlay: false },
  { name: "CR",   label: "CR",                      overlay: false },
];
const IND_COLORS = {
  MA:"#58a6ff", EMA:"#a78bfa", SMA:"#67e8f9", BOLL:"#d29922",
  SAR:"#f97316", BBI:"#ec4899",
  MACD:"#e78284", KDJ:"#f0883e", RSI:"#34d399", CCI:"#a78bfa",
  DMI:"#60a5fa", WR:"#fb923c", BRAR:"#f472b6", MTM:"#fbbf24",
  OBV:"#4ade80", VR:"#38bdf8", ROC:"#c084fc", PSY:"#fb7185",
  TRIX:"#fdba74", EMV:"#86efac", AO:"#fde68a", DPO:"#d4d4d8",
  BIAS:"#f9a8d4", VOL:"#3fb950", DMA:"#7dd3fc", CR:"#fca5a5",
};

// --------------------------------------------------------------------------- //
// Ticker search (case-insensitive autocomplete that fills the symbol)
// --------------------------------------------------------------------------- //
const searchEl = document.getElementById("search");
const sugEl = document.getElementById("suggestions");
const countryEl = document.getElementById("country");
const exchangeEl = document.getElementById("exchange");
let sugItems = [];
let sugActive = -1;
let searchTimer = null;
let exchangeMap = {};        // country -> [exchange, …]
let currentExchange = "";    // selected exchange code ("" = all markets)

// --- Country / exchange drilldown -----------------------------------------
// Country name -> ISO-3166 alpha-2, so we can prefix each option with a flag
// emoji (reusing _flag()). Covers every country the backend exposes.
const COUNTRY_ISO = {
  "United States": "US", "China": "CN", "Hong Kong": "HK", "Japan": "JP",
  "United Kingdom": "GB", "Canada": "CA", "Australia": "AU", "India": "IN",
  "Germany": "DE", "France": "FR", "South Korea": "KR",
  "Switzerland": "CH", "Brazil": "BR",
};
// Display-name overrides (value stays the backend key so lookups still work).
const COUNTRY_LABEL = { "China": "Mainland China" };
// Dropped: the Taiwan flag emoji isn't reliably rendered across fonts, so per
// the request we omit Taiwan rather than show a flag-less entry.
const COUNTRY_SKIP = new Set(["Taiwan"]);
async function loadExchanges() {
  try {
    const r = await fetch("/api/exchanges");
    exchangeMap = await r.json();
  } catch { exchangeMap = {}; }
  for (const country of Object.keys(exchangeMap)) {
    if (COUNTRY_SKIP.has(country)) continue;
    const opt = document.createElement("option");
    const flag = _flag(COUNTRY_ISO[country] || "");
    const label = COUNTRY_LABEL[country] || country;
    opt.value = country; opt.textContent = flag ? `${flag} ${label}` : label;
    countryEl.appendChild(opt);
  }
}
countryEl.addEventListener("change", () => {
  const exchanges = exchangeMap[countryEl.value] || [];
  exchangeEl.innerHTML = "";
  if (!exchanges.length) {
    exchangeEl.disabled = true;
    exchangeEl.innerHTML = `<option value="">Exchange</option>`;
    currentExchange = "";
  } else {
    exchangeEl.disabled = false;
    exchanges.forEach((ex) => {
      const opt = document.createElement("option");
      opt.value = ex.code; opt.textContent = ex.label;
      exchangeEl.appendChild(opt);
    });
    currentExchange = exchanges[0].code;   // default to the first exchange
  }
  _updateSearchPlaceholder();
  if (searchEl.value.trim()) runSearch(searchEl.value.trim());
});
exchangeEl.addEventListener("change", () => {
  currentExchange = exchangeEl.value;
  _updateSearchPlaceholder();
  if (searchEl.value.trim()) runSearch(searchEl.value.trim());
});
function _updateSearchPlaceholder() {
  if (currentExchange) {
    const country = COUNTRY_LABEL[countryEl.value] || countryEl.value;
    searchEl.placeholder = `Search ${country} · ${exchangeEl.options[exchangeEl.selectedIndex].text} by name or code…`;
  } else {
    searchEl.placeholder = "Search a stock or index by name or symbol (e.g. apple, SPY, nvidia)…";
  }
}
loadExchanges();

searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchEl.value.trim();
  if (q.length < 1) { hideSuggestions(); return; }
  searchTimer = setTimeout(() => runSearch(q), 200);
});
searchEl.addEventListener("keydown", (e) => {
  if (!sugEl.classList.contains("show")) return;
  if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
  else if (e.key === "Enter") { e.preventDefault(); if (sugActive >= 0) pick(sugItems[sugActive]); }
  else if (e.key === "Escape") { hideSuggestions(); }
});
document.addEventListener("click", (e) => { if (!searchEl.contains(e.target)) hideSuggestions(); });

// Full US ticker+name list, loaded once for instant English autosuggest.
let localSymbols = [];
let lastQuery = "";
fetch("/api/symbols")
  .then((r) => r.json())
  .then((rows) => { localSymbols = Array.isArray(rows) ? rows : []; })
  .catch(() => { localSymbols = []; });

// Client-side ranking that mirrors the server: match a ticker ("aapl") or a
// company name ("apple"); exact ticker > ticker prefix > name word-prefix > sub.
function localRank(q, limit = 10) {
  q = q.trim().toLowerCase();
  if (!q || !localSymbols.length) return [];
  const exact = [], symPre = [], namePre = [], sub = [];
  for (const r of localSymbols) {
    const sym = r.symbol.toLowerCase();
    const name = (r.name || "").toLowerCase();
    if (sym === q) exact.push(r);
    else if (sym.startsWith(q)) symPre.push(r);
    else if (name.startsWith(q) || name.split(" ").some((w) => w.startsWith(q))) namePre.push(r);
    else if (sym.includes(q) || name.includes(q)) sub.push(r);
    if (exact.length + symPre.length + namePre.length + sub.length > 400) break;
  }
  symPre.sort((a, b) => a.symbol.length - b.symbol.length);
  return [...exact, ...symPre, ...namePre, ...sub]
    .slice(0, limit)
    .map((r) => ({ symbol: r.symbol, name: r.name, exchange: "US", type: "EQUITY" }));
}

function _mergeItems(primary, extra, limit = 10) {
  const seen = new Set(primary.map((r) => r.symbol.toUpperCase()));
  const out = [...primary];
  for (const r of extra) {
    if (out.length >= limit) break;
    if (!seen.has(r.symbol.toUpperCase())) { out.push(r); seen.add(r.symbol.toUpperCase()); }
  }
  return out;
}

async function runSearch(q) {
  lastQuery = q;
  // Instant local pass for ticker/name (US + all-markets) — no network wait.
  const useLocal = currentExchange === "" || currentExchange === "US";
  if (useLocal) {
    sugItems = localRank(q);
    if (sugItems.length) renderSuggestions();
  }
  // Network pass: scoped to the exchange, or global Yahoo when none chosen.
  try {
    let url = `/api/search?q=${encodeURIComponent(q)}`;
    if (currentExchange) url += `&exchange=${encodeURIComponent(currentExchange)}`;
    const r = await fetch(url);
    const remote = await r.json();
    if (q !== lastQuery) return;  // a newer keystroke superseded this request
    sugItems = useLocal ? _mergeItems(sugItems, remote) : remote;
  } catch {
    if (!useLocal) sugItems = [];
  }
  renderSuggestions();
}

// Escape user text before injecting into innerHTML, then bold the matched span.
function _esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}
function _mark(text, q) {
  const safe = _esc(text);
  if (!q) return safe;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return safe;
  return _esc(text.slice(0, i)) + "<mark>" + _esc(text.slice(i, i + q.length))
       + "</mark>" + _esc(text.slice(i + q.length));
}

function renderSuggestions() {
  sugEl.innerHTML = "";
  sugActive = -1;
  if (!sugItems.length) { hideSuggestions(); return; }
  const q = searchEl.value.trim();
  sugItems.forEach((it, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span><span class="sym">${_mark(it.symbol, q)}</span> ${_mark(it.name || "", q)}</span>`
                 + `<span class="exch">${_esc(it.exchange || "")} ${_esc(it.type || "")}</span>`;
    li.addEventListener("mouseenter", () => { sugActive = i; highlight(); });
    li.addEventListener("click", () => pick(it));
    sugEl.appendChild(li);
  });
  sugEl.classList.add("show");
}
function highlight() {
  [...sugEl.children].forEach((li, i) => li.classList.toggle("active", i === sugActive));
}
function moveActive(d) {
  sugActive = (sugActive + d + sugItems.length) % sugItems.length;
  highlight();
}
function hideSuggestions() { sugEl.classList.remove("show"); }
function pick(it) {
  searchEl.value = `${it.symbol} — ${it.name || ""}`.trim();
  hideSuggestions();
  selectTicker(it.symbol);
}

function selectTicker(symbol) {
  currentTicker = symbol;
  document.getElementById("run").disabled = false;
  setStatus(`ready — ${symbol}`);
  loadPrices();
  showProChart(symbol);   // KLineChart Pro candlestick widget
  loadQuote();
  loadSignals();
  loadFinChart();
  loadTickerNews();
  _fundLoaded = _finLoaded = _techLoaded = false;  // reset lazy data tabs
  _dashOvTicker = null;                            // overview re-loads for new ticker
  const ct = document.getElementById("coord-ticker"); if (ct) ct.value = symbol;
  refreshActiveDataTab();  // re-load whichever data tab is currently open
}

// Re-run the loader for the currently-active analysis sub-tab (so picking a
// ticker while e.g. Fundamentals is open refreshes it instead of leaving a
// stale placeholder).
function refreshActiveDataTab() {
  const active = document.querySelector("#atabs button.active");
  const tab = active && active.dataset.atab;
  if (!currentTicker) return;
  if (tab === "overview") loadDashOverview();
  else if (tab === "fundamentals") { _fundLoaded = true; loadFundamentals(); }
  else if (tab === "financials") { _finLoaded = true; loadFinancials(); }
  else if (tab === "technicals") { _techLoaded = true; loadTechnicals(); }
}

// --------------------------------------------------------------------------- //
// Price chart — KLineChart Pro (built-in periods, indicators, drawing tools).
// Fed by a custom datafeed over our own /api/prices + /api/search endpoints;
// Pro supplies the whole chart UI (the old ranges toolbar + indicator search
// were removed in favour of its native controls).
// --------------------------------------------------------------------------- //
let _proChart = null, _dashDatafeed = null;

// Each Pro period maps to one of our /api/prices range presets (which bundle a
// yfinance interval + a history window). Intraday windows are short by nature.
const _PRO_PERIODS = [
  { multiplier: 1,  timespan: "minute", text: "1m" },
  { multiplier: 5,  timespan: "minute", text: "5m" },
  { multiplier: 15, timespan: "minute", text: "15m" },
  { multiplier: 30, timespan: "minute", text: "30m" },
  { multiplier: 1,  timespan: "hour",   text: "1H" },
  { multiplier: 1,  timespan: "day",    text: "1D" },
  { multiplier: 1,  timespan: "week",   text: "1W" },
  { multiplier: 1,  timespan: "month",  text: "1M" },
];
const _DEFAULT_PERIOD = _PRO_PERIODS[5]; // 1D
// Map a Pro period to our backend interval token (see /api/prices ?interval=).
function _periodToInterval(p) {
  const t = p.timespan, m = p.multiplier;
  if (t === "minute") return m >= 30 ? "30m" : m >= 15 ? "15m" : m >= 5 ? "5m" : "1m";
  if (t === "hour")   return "1h";
  if (t === "week")   return "1wk";
  if (t === "month")  return "1mo";
  return "1d";
}

// Datafeed: symbol search + history over our backend; no realtime stream.
class DashDatafeed {
  constructor() { this._cache = {}; this._lastKey = null; }
  async searchSymbols(search) {
    if (!search) return [];
    try {
      const arr = await (await fetch(`/api/search?q=${encodeURIComponent(search)}`)).json();
      return (arr || []).map((it) => ({
        ticker: it.symbol, shortName: it.symbol, name: it.name || it.symbol,
        exchange: it.exchange || "", market: "stocks",
        priceCurrency: "usd", type: it.type || "stock",
      }));
    } catch { return []; }
  }
  async getHistoryKLineData(symbol, period, from, to) {
    const interval = _periodToInterval(period);
    const key = `${symbol.ticker}|${interval}`;
    // /api/prices returns the interval's whole window (1m→7d, 1wk→max, …), NOT
    // an arbitrary [from,to] slice. Pro calls this on each symbol/period change
    // AND when scrolling back for more history. We must serve the full window
    // on a change (don't filter by from/to — Pro anchors the window to "now",
    // which would otherwise drop the last trading day's intraday bars OR a whole
    // different-interval view), and return [] only when Pro pages the SAME view
    // again (so it stops asking instead of looping or blanking).
    if (this._lastKey === key) return [];
    this._lastKey = key;
    let candles = this._cache[key];
    if (!candles) {
      try {
        const d = await (await fetch(`/api/prices?ticker=${encodeURIComponent(symbol.ticker)}&interval=${interval}`)).json();
        candles = (d.candles || []).map((p) => ({
          timestamp: p.t, open: p.o, high: p.h, low: p.l, close: p.c, volume: p.v,
        }));
      } catch { candles = []; }
      this._cache[key] = candles;
    }
    return candles;
  }
  subscribe() {}    // no live websocket feed in this build
  unsubscribe() {}
}

function _symbolInfo(ticker, name) {
  return {
    ticker, shortName: ticker, name: name || ticker,
    exchange: "", market: "stocks", priceCurrency: "usd", type: "stock",
  };
}

// Build the Pro chart on the first ticker, then just switch symbols afterwards.
function showProChart(ticker, name) {
  if (typeof klinechartspro === "undefined" || !ticker) return;  // CDN not ready
  const sym = _symbolInfo(ticker, name);
  if (_proChart) { _proChart.setSymbol(sym); return; }
  const el = document.getElementById("tv-chart");
  if (!el) return;
  el.innerHTML = "";
  _dashDatafeed = _dashDatafeed || new DashDatafeed();
  try {
    _proChart = new klinechartspro.KLineChartPro({
      container: el,
      symbol: sym,
      period: _DEFAULT_PERIOD,
      periods: _PRO_PERIODS,
      theme: "dark",
      locale: "en-US",
      drawingBarVisible: true,
      mainIndicators: ["MA"],
      subIndicators: ["VOL"],
      datafeed: _dashDatafeed,
    });
  } catch (err) {
    el.innerHTML = `<p class="dash-empty">Chart failed to load: ${_esc(String(err))}</p>`;
  }
}

async function loadPrices() {
  if (!currentTicker) return;
  const r = await fetch(`/api/prices?ticker=${encodeURIComponent(currentTicker)}&range=${currentRange}`);
  _lastPriceData = await r.json();
  const data = _lastPriceData;

  // The rich quote header is filled by loadQuote(); here we just keep the
  // live last/change in sync with the charted candles (freshest intraday).
  const last = document.getElementById("q-last");
  const chg = document.getElementById("q-change");
  if (last && data.last != null) last.textContent = data.last.toFixed(2);
  if (chg && data.change_pct != null) {
    chg.textContent = `${data.change_pct >= 0 ? "▲" : "▼"} ${data.change_pct.toFixed(2)}%`;
    chg.className = "q-change " + (data.change_pct >= 0 ? "up" : "down");
  }
  // The candlestick chart itself is the KLineChart Pro widget (see showProChart).
}

// --------------------------------------------------------------------------- //
// Agent coordination — data-collector cards + live debate pipeline.
// Analysts are COLLECTORS (no conviction/bias shown); the bull, bear and judge
// are the only agents that interpret. We keep the SSE-facing function names
// (buildGraph / setNodeStatus / flow / showBubble / hideBubble) so the event
// loop in handleEvent() is unchanged.
// --------------------------------------------------------------------------- //
const COORD_AGENTS = [
  { key: "market",       name: "Technical Analyst",    role: "Charts · indicators · price action", icon: "📈" },
  { key: "fundamentals", name: "Fundamentals Analyst", role: "Statements · valuation · filings",    icon: "📊" },
  { key: "news",         name: "News Analyst",         role: "Headlines · catalysts · events",      icon: "📰" },
  { key: "social",       name: "Sentiment Analyst",    role: "Social chatter · retail mood",        icon: "💬", img: "/static/sentiment.png?v=3" },
  { key: "smart_money",  name: "Smart-Money Analyst",  role: "Insiders · congress · flows",         icon: "🐋" },
  { key: "macro",        name: "Macro Analyst",        role: "Rates · inflation · growth · labor",  icon: "🌐" },
];
// Backend DISPLAY_NAME (what status/report events carry) -> collector key.
const NAME_TO_KEY = {
  "Market Analyst": "market", "Fundamentals Analyst": "fundamentals",
  "News Analyst": "news", "Sentiment Analyst": "social",
  "Smart-Money Analyst": "smart_money", "Macro Analyst": "macro",
};
// Display name -> selection value, used by startRun to hide unselected agents.
const ANALYST_NODE = {
  "Market Analyst": "market", "Fundamentals Analyst": "fundamentals",
  "News Analyst": "news", "Sentiment Analyst": "social",
  "Smart-Money Analyst": "smart_money", "Macro Analyst": "macro",
};
// Pipeline order: collectors (only selected shown) → Bull → Bear → Judge.
const PIPE_RESEARCH = [
  { id: "bull",  name: "Bull",  icon: "🐂", cls: "bull" },
  { id: "bear",  name: "Bear",  icon: "🐻", cls: "bear" },
  { id: "judge", name: "Judge", icon: "⚖️", cls: "judge" },
];
const DISPLAY_TO_PIPE = {
  "Bull Researcher": "bull", "Bear Researcher": "bear", "Judge": "judge",
};

const agentListEl = () => document.getElementById("coord-agent-list");
const pipeEl      = () => document.getElementById("coord-pipeline");
const eventLogEl  = () => document.getElementById("coord-eventlog");

// key/pipe-id -> card / pipeline DOM element
const cardEls = {};
const pipeNodeEls = {};

function buildGraph() {
  const selected = startRunSelected();
  const list = agentListEl();
  const pipe = pipeEl();
  if (!list || !pipe) return;
  Object.keys(cardEls).forEach((k) => delete cardEls[k]);
  Object.keys(pipeNodeEls).forEach((k) => delete pipeNodeEls[k]);
  list.innerHTML = "";
  pipe.innerHTML = "";

  const shown = COORD_AGENTS.filter((a) => !selected || selected.includes(a.key));
  const count = document.getElementById("coord-agent-count");
  if (count) count.textContent = String(shown.length);

  // Left-column data-collector cards (no conviction, no bias).
  shown.forEach((a) => {
    const card = document.createElement("div");
    card.className = "coord-agent pending";
    card.dataset.key = a.key;
    card.innerHTML =
      `<div class="ca-ico">${a.img ? `<img src="${a.img}" alt="" class="ca-img">` : a.icon}</div>`
      + `<div class="ca-meta"><div class="ca-name">${_esc(a.name)}</div>`
      + `<div class="ca-role">${_esc(a.role)}</div>`
      + `<div class="ca-sub" data-sub>Idle</div></div>`
      + `<div class="ca-dot"></div>`;
    card.addEventListener("click", () => {
      const dn = displayNameForKey(a.key);
      if (reports.has(dn)) { switchReadTab("reports"); showReport(dn); }
    });
    list.appendChild(card);
    cardEls[a.key] = card;
  });

  // Bottom pipeline: collectors then researchers then judge.
  const pnodes = shown.map((a) => ({ id: a.key, name: a.name.replace(" Analyst", ""), icon: a.icon, cls: "" }))
    .concat(PIPE_RESEARCH);
  pnodes.forEach((n, i) => {
    if (i > 0) {
      const arrow = document.createElement("div");
      arrow.className = "pipe-arrow";
      arrow.dataset.into = n.id;
      pipe.appendChild(arrow);
    }
    const node = document.createElement("div");
    node.className = `pipe-node pending ${n.cls}`;
    node.dataset.id = n.id;
    node.innerHTML = `<div class="pn-ico">${n.icon}</div><div class="pn-name">${_esc(n.name)}</div>`;
    pipe.appendChild(node);
    pipeNodeEls[n.id] = node;
  });

  const log = eventLogEl();
  if (log) log.innerHTML = "";
}

// Returns the selected collector keys, or null if checkboxes aren't present.
function startRunSelected() {
  const boxes = document.querySelectorAll("#page-coord .coord-analysts-bar input:checked");
  if (!boxes.length) return null;
  return [...boxes].map((c) => c.value);
}

function displayNameForKey(key) {
  const a = COORD_AGENTS.find((x) => x.key === key);
  // backend display name == card name except market ("Market Analyst")
  return key === "market" ? "Market Analyst" : (a ? a.name : key);
}

// Set status on a collector card and/or its pipeline node. `name` is a backend
// DISPLAY_NAME ("Market Analyst", "Bull Researcher", "Judge", …).
function setNodeStatus(name, status) {
  const key = NAME_TO_KEY[name];
  const pid = key || DISPLAY_TO_PIPE[name];
  if (key && cardEls[key]) {
    const card = cardEls[key];
    card.className = `coord-agent ${status}`;
    const sub = card.querySelector("[data-sub]");
    if (sub) sub.textContent = status === "in_progress" ? "Collecting data…"
                              : status === "completed" ? "Data collected ✓" : "Idle";
  }
  if (pid && pipeNodeEls[pid]) {
    pipeNodeEls[pid].className =
      `pipe-node ${status} ${PIPE_RESEARCH.find((p) => p.id === pid)?.cls || ""}`;
  }
}

// Substatus text on the researcher cards / pipeline ("thinking", "countering").
function showBubble(name, text, mode) {
  const pid = DISPLAY_TO_PIPE[name];
  if (pid && pipeNodeEls[pid]) pipeNodeEls[pid].classList.add("busy");
}
function hideBubble(name) {
  const pid = DISPLAY_TO_PIPE[name];
  if (pid && pipeNodeEls[pid]) pipeNodeEls[pid].classList.remove("busy");
}

// A "report handed off" pulse: light the target pipeline node's inbound arrow
// and drop a timestamped line into the live event log.
function flow(src, dst, summary) {
  const srcId = NAME_TO_KEY[src] || DISPLAY_TO_PIPE[src];
  const dstId = DISPLAY_TO_PIPE[dst];
  const pipe = pipeEl();
  if (pipe && dstId) {
    pipe.querySelectorAll(`.pipe-arrow[data-into="${dstId}"]`).forEach((a) => {
      a.classList.add("lit");
      setTimeout(() => a.classList.remove("lit"), 1400);
    });
  }
  _pipePacket(srcId, dstId);   // a glowing packet travels src → dst
  logEvent(`${src} → ${dst}`, summary);
}

// A data "packet" that animates along the pipeline from one node to another,
// visualising info flowing collector → researcher → judge.
function _pipePacket(srcId, dstId) {
  const pipe = pipeEl(); if (!pipe) return;
  const s = pipeNodeEls[srcId], d = pipeNodeEls[dstId];
  if (!s || !d) return;
  const pr = pipe.getBoundingClientRect(), sr = s.getBoundingClientRect(), dr = d.getBoundingClientRect();
  const x0 = sr.left + sr.width / 2 - pr.left, y0 = sr.top + sr.height / 2 - pr.top;
  const x1 = dr.left + dr.width / 2 - pr.left, y1 = dr.top + dr.height / 2 - pr.top;
  const dot = document.createElement("div");
  dot.className = "pipe-packet";
  dot.style.left = `${x0}px`; dot.style.top = `${y0}px`;
  pipe.appendChild(dot);
  requestAnimationFrame(() => {
    dot.style.transform = `translate(${x1 - x0}px, ${y1 - y0}px)`;
    dot.style.opacity = "0.15";
  });
  setTimeout(() => dot.remove(), 950);
}

// Timestamped event line in the bottom-left "DEBATE FLOW" log.
function logEvent(head, detail) {
  const log = eventLogEl(); if (!log) return;
  const empty = log.querySelector(".dash-empty"); if (empty) empty.remove();
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const row = document.createElement("div");
  row.className = "cev-row";
  row.innerHTML = `<span class="cev-ts">${ts}</span><span class="cev-head">${_esc(head)}</span>`
                + (detail ? `<span class="cev-detail">${_esc(String(detail).slice(0, 60))}</span>` : "");
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

// Reading-window tab switching (Analyst Reports / Debate / Verdict).
function switchReadTab(tab) {
  document.querySelectorAll("#coord-read-tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.rtab === tab));
  document.querySelectorAll(".crt-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `crt-${tab}`));
}

// --------------------------------------------------------------------------- //
// Output window: one report shown at a time, with tabs to revisit any agent.
// --------------------------------------------------------------------------- //
const outputEl  = document.getElementById("output");
const verdictEl = document.getElementById("verdict");
const tabsEl    = document.getElementById("report-tabs");
const reportEl  = document.getElementById("report-view");

// agent -> { summary, content }; insertion order drives tab order.
const reports = new Map();
let activeReport = null;

function logLine(text) {
  const d = document.createElement("div");
  d.className = "log"; d.textContent = text;
  outputEl.appendChild(d); outputEl.scrollTop = outputEl.scrollHeight;
}

function resetReports() {
  reports.clear(); activeReport = null;
  tabsEl.innerHTML = "";
  reportEl.innerHTML = `<p class="report-empty">Running… reports will appear here.</p>`;
}

// Style the vertical Tree-of-Thoughts chains: each path is a <p> with the
// fact/reasoning/conclusion steps on their own lines (<br>). Brackets become
// thought chips, arrows are highlighted, the probability gets its own pill.
function styleToT(container) {
  container.querySelectorAll("p").forEach((p) => {
    if (!/—>|→/.test(p.textContent)) return;
    p.classList.add("tot-line");
    p.innerHTML = p.innerHTML
      .replace(/(—&gt;|—>|→)/g, '<span class="tot-arrow">→</span>')
      .replace(/\b(probability\s+[\d.]+%?)/gi, '<span class="tot-prob">$1</span>')
      .replace(/\[([^\[\]]+)\]/g, '<span class="tot-thought">[$1]</span>');
  });
}

function addReport(agent, summary, content) {
  const isNew = !reports.has(agent);
  reports.set(agent, { summary: summary || "", content: content || "" });
  if (isNew) {
    const btn = document.createElement("button");
    btn.className = "report-tab"; btn.dataset.agent = agent;
    btn.textContent = agent;
    btn.addEventListener("click", () => showReport(agent));
    tabsEl.appendChild(btn);
  }
  showReport(agent);  // jump to the freshest report
}

function showReport(agent) {
  const r = reports.get(agent); if (!r) return;
  activeReport = agent;
  [...tabsEl.children].forEach((b) => b.classList.toggle("active", b.dataset.agent === agent));
  reportEl.innerHTML =
    `<div class="report-head"><span class="agent-tag">${agent}</span>`
    + `<span class="topic">${r.summary}</span></div>`
    + `<div class="report-body">${window.marked ? marked.parse(r.content) : r.content}</div>`;
  styleToT(reportEl.querySelector(".report-body"));
  reportEl.scrollTop = 0;
}

// --------------------------------------------------------------------------- //
// Debate window (alternating bull/bear turns) + consensus
// --------------------------------------------------------------------------- //
const debatePanel = document.getElementById("debate-panel");
const debateEl    = document.getElementById("debate");
const debateStatus = document.getElementById("debate-status");
const consensusEl = document.getElementById("consensus");

// Collected for export (.md / .pdf): debate turns, consensus, final verdict.
let _exportDebate = [];
let _exportConsensus = null;
let _exportVerdict = null;

function resetDebate() {
  debatePanel.hidden = true;
  debateEl.innerHTML = "";
  consensusEl.innerHTML = "";
  debateStatus.textContent = "";
  _exportDebate = [];
  _exportConsensus = null;
  _animateDebate(null);
}

function setArenaIntensity(label) {
  const el = document.getElementById("arena-intensity"); if (!el) return;
  el.textContent = label;
  el.className = "arena-int-" + label.toLowerCase();
}

function addDebateTurn(ev) {
  debatePanel.hidden = false;
  debateStatus.textContent = `round ${ev.round} / ${ev.rounds}`;
  const node = ev.side === "bull" ? "Bull Researcher" : "Bear Researcher";
  showBubble(node, null, "countering");   // pipeline node: busy
  const rounds = +ev.rounds || 3;
  setArenaIntensity(rounds >= 5 ? "HIGH" : rounds >= 3 ? "MEDIUM" : "LOW");
  logEvent(`${ev.side === "bull" ? "🐂 Bull" : "🐻 Bear"} — round ${ev.round}`, ev.summary);
  _animateDebate(ev.side);   // arena clash: the speaking side lunges/glows

  _exportDebate.push({ side: ev.side, round: ev.round, rounds: ev.rounds,
                       summary: ev.summary || "", content: ev.content || "" });

  const turn = document.createElement("div");
  turn.className = `debate-turn ${ev.side}`;
  turn.innerHTML =
    `<div class="dt-head"><span class="dt-side">${ev.side === "bull" ? "🐂 Bull" : "🐻 Bear"}</span>`
    + `<span class="dt-round">R${ev.round}</span></div>`
    + `<div class="dt-summary">${ev.summary || ""}</div>`
    + `<div class="dt-body">${window.marked ? marked.parse(ev.content || "") : (ev.content || "")}</div>`;
  debateEl.appendChild(turn);
  debateEl.scrollTop = debateEl.scrollHeight;
}

function showConsensus(ev) {
  debatePanel.hidden = false;
  _exportConsensus = { reached: !!ev.consensus_reached, content: ev.content || "" };
  const ok = ev.consensus_reached;
  debateStatus.textContent = ok ? "consensus ✓" : "no consensus — Judge decides";
  if (!ok) setArenaIntensity("HIGH");
  let html = `<div class="consensus-banner ${ok ? "yes" : "no"}">`
           + (ok ? "✓ Consensus reached" : "⚖️ No consensus — the Judge decides") + `</div>`;
  html += window.marked ? marked.parse(ev.content || "") : (ev.content || "");
  consensusEl.innerHTML = html;
  logEvent(ok ? "Consensus reached ✓" : "No consensus — Judge decides");
  // the researchers are done countering
  ["Bull Researcher", "Bear Researcher"].forEach(hideBubble);
  _animateDebate(null);   // clear the clash state
}

// Arena debate animation: the side that just spoke lunges + glows, the VS badge
// flashes, and an animated bolt connects the two. `side` null clears it.
function _animateDebate(side) {
  const bull = document.querySelector("#page-coord .arena-side.bull");
  const bear = document.querySelector("#page-coord .arena-side.bear");
  const vs = document.querySelector("#page-coord .arena-vs-badge");
  if (bull) bull.classList.toggle("speaking", side === "bull");
  if (bear) bear.classList.toggle("speaking", side === "bear");
  const arena = document.querySelector("#page-coord .arena-vs");
  if (arena) arena.classList.toggle("debating", !!side);
  if (vs && side) { vs.classList.remove("clash"); void vs.offsetWidth; vs.classList.add("clash"); }
}

// --------------------------------------------------------------------------- //
// Time + token trackers
// --------------------------------------------------------------------------- //
const elapsedPill = document.getElementById("elapsed-pill");
const tokenPill   = document.getElementById("token-pill");
let _timer = null, _t0 = 0;

function startTrackers() {
  _t0 = Date.now();
  tokenPill.textContent = "⬆ 0 · ⬇ 0";
  clearInterval(_timer);
  _timer = setInterval(() => {
    const s = Math.floor((Date.now() - _t0) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    elapsedPill.textContent = `⏱ ${mm}:${ss}`;
  }, 1000);
}
function stopTrackers() { clearInterval(_timer); _timer = null; }
function updateTokens(ev) {
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
  tokenPill.textContent = `⬆ ${fmt(ev.tokens_in || 0)} · ⬇ ${fmt(ev.tokens_out || 0)}`;
}

// Clear every verdict-driven region of the coordination terminal.
function resetVerdict() {
  if (verdictEl) verdictEl.innerHTML = "";
  const vf = document.getElementById("verdict-full");
  if (vf) vf.innerHTML = `<p class="report-empty">The Judge's full verdict appears here.</p>`;
  const drivers = document.getElementById("coord-drivers");
  if (drivers) drivers.innerHTML = `<p class="dash-empty">The Judge's scoreboard appears here after a run.</p>`;
  ["coord-ev-bull", "coord-ev-bear"].forEach((id) => { const e = document.getElementById(id); if (e) e.innerHTML = ""; });
  ["arena-bull-pct", "arena-bear-pct"].forEach((id) => { const e = document.getElementById(id); if (e) e.textContent = "—"; });
  setArenaIntensity("—");
}

function renderVerdict(ev) {
  _exportVerdict = {
    ticker: currentTicker || ev.ticker || "",
    rating: (ev.rating || ev.decision || "").toString(),
    decision: ev.decision, weighted_score: ev.weighted_score,
    scoreboard: ev.scoreboard || [], verdict_md: ev.verdict_md || "",
  };
  const rating = (ev.rating || ev.decision || "").toString();
  const rcls = rating.toLowerCase().replace(/[^a-z]/g, "");
  const score = ev.weighted_score;

  // Bull/Bear confidence split, derived from the Judge's signed score.
  if (typeof score === "number") {
    const bull = Math.round(((score + 1) / 2) * 100);
    const setPct = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v + "%"; };
    setPct("arena-bull-pct", bull);
    setPct("arena-bear-pct", 100 - bull);
  }

  // Final-verdict box in the arena.
  const score100 = typeof score === "number" ? Math.round(((score + 1) / 2) * 100) : null;
  let head = `<div class="av-label">FINAL VERDICT</div>`
    + `<div class="av-rating ${rcls}">${_esc(rating || "—")}${score100 != null ? ` <span class="av-score">${score100}/100</span>` : ""}</div>`;
  if (typeof score === "number") {
    const pos = ((score + 1) / 2) * 100;
    head += `<div class="bar"><div class="mark" style="left:${pos}%"></div></div>`
      + `<div class="av-meta">weighted score ${score >= 0 ? "+" : ""}${score.toFixed(2)} &nbsp;·&nbsp; −1 bearish … +1 bullish</div>`;
  }
  if (verdictEl) verdictEl.innerHTML = head;

  // Right-column verdict-driver bars + Top Evidence (the Judge's scoreboard).
  const board = ev.scoreboard || [];
  const drivers = document.getElementById("coord-drivers");
  if (drivers) {
    if (!board.length) {
      drivers.innerHTML = `<p class="dash-empty">No scoreboard returned.</p>`;
    } else {
      const maxAbs = Math.max(0.01, ...board.map((e) => Math.abs(+e.score || 0)));
      drivers.innerHTML = board.map((e) => {
        const sc = +e.score || 0;
        const w = Math.round((Math.abs(sc) / maxAbs) * 50);  // half-width %
        const side = sc >= 0 ? "pos" : "neg";
        return `<div class="vd-row">`
          + `<div class="vd-name">${_esc(e.metric)}<span class="vd-src">${_esc(e.source || "")}</span></div>`
          + `<div class="vd-track"><div class="vd-bar ${side}" style="width:${w}%"></div></div>`
          + `<div class="vd-val ${side}">${sc >= 0 ? "+" : ""}${sc.toFixed(2)}<span class="vd-wt">w${(+e.weight || 0).toFixed(2)}</span></div>`
          + `</div>`;
      }).join("");
    }
  }
  // Split scoreboard rows into bullish / bearish evidence.
  const evBull = document.getElementById("coord-ev-bull");
  const evBear = document.getElementById("coord-ev-bear");
  if (evBull && evBear) {
    evBull.innerHTML = ""; evBear.innerHTML = "";
    board.forEach((e) => {
      const sc = +e.score || 0; if (!sc) return;
      const li = `<li><span class="cev-arrow">${sc >= 0 ? "▲" : "▼"}</span>${_esc(e.metric)}`
        + `${e.raw_value != null && e.raw_value !== "" ? ` — ${_esc(String(e.raw_value))}` : ""}</li>`;
      (sc >= 0 ? evBull : evBear).insertAdjacentHTML("beforeend", li);
    });
    if (!evBull.children.length) evBull.innerHTML = `<li class="cev-none">—</li>`;
    if (!evBear.children.length) evBear.innerHTML = `<li class="cev-none">—</li>`;
  }

  // Full verdict markdown in the reading window's Judge tab.
  const vf = document.getElementById("verdict-full");
  if (vf) {
    const md = ev.verdict_md || "";
    vf.innerHTML = md ? (window.marked ? marked.parse(md) : _esc(md)) : head;
  }

  logEvent(`Judge verdict — ${rating}${score100 != null ? ` (${score100}/100)` : ""}`);

  // Drive the legacy Agent Consensus gauge if its elements still exist.
  if (typeof score === "number") {
    _agentRan = true;
    const pct = Math.round((score + 1) / 2 * 100);
    const label = pct >= 60 ? "Bullish" : pct <= 40 ? "Bearish" : "Neutral";
    renderConsensus({ pct, label }, true);
  }
}

// --------------------------------------------------------------------------- //
// Run analysis (SSE)
// --------------------------------------------------------------------------- //
const runBtn = document.getElementById("run");
runBtn.addEventListener("click", startRun);

function setStatus(text) { document.getElementById("status-pill").textContent = text; }

const RUN_LS_KEY = "tb_run";   // persists the active run id across refreshes

// Prepare the coordination page for a (new or resumed) run.
function _prepCoordForRun() {
  gotoPage("coord");
  buildGraph();   // reads the checkboxes and shows only selected agents
  if (outputEl) outputEl.innerHTML = "";
  resetVerdict();
  resetReports();
  resetDebate();
  startTrackers();
  setCoordLive("running");
  runBtn.disabled = true;
  setStatus("running…");
}

function _attachSSE(url) {
  sse = new EventSource(url);
  sse.onmessage = (e) => handleEvent(JSON.parse(e.data));
  sse.onerror = () => { logLine("connection closed"); endRun(); };
}

function startRun() {
  if (!currentTicker || sse) return;
  const analysts = startRunSelected();
  if (!analysts || !analysts.length) { setStatus("pick at least one collector"); return; }
  const provider = document.getElementById("provider").value;
  const depth = document.getElementById("depth").value;
  const language = document.getElementById("language").value;

  _prepCoordForRun();

  const params = new URLSearchParams({
    ticker: currentTicker, analysts: analysts.join(","),
    provider, research_depth: depth, language,
  });
  _attachSSE(`/api/analyze?${params.toString()}`);
}

// On load, reattach to a run that was still going when the page was refreshed.
// The server replays the buffered conversation, then streams the rest.
async function resumeRunIfAny() {
  if (sse) return;
  let runId = null, ticker = null;
  // 1) Prefer the id this browser saved when it started the run.
  try {
    const saved = JSON.parse(localStorage.getItem(RUN_LS_KEY) || "null");
    if (saved && saved.id) { runId = saved.id; ticker = saved.ticker; }
  } catch {}
  // 2) Fallback: ask the server if any run is still live (covers a run started
  //    before this code loaded, or when localStorage was cleared/blocked).
  if (!runId) {
    try {
      const a = await (await fetch("/api/analyze/active")).json();
      if (a && a.active) { runId = a.run_id; ticker = a.ticker; }
    } catch {}
  }
  if (!runId || sse) return;
  if (ticker) currentTicker = currentTicker || ticker;
  _prepCoordForRun();
  logLine("Reconnecting to your analysis…");
  _attachSSE(`/api/analyze?resume=${encodeURIComponent(runId)}`);
}

// Toggle the live indicator on the coordination header.
function setCoordLive(state) {
  const el = document.getElementById("coord-live"); if (!el) return;
  el.className = "coord-live " + state;
  el.textContent = state === "running" ? "● Live — running" :
                   state === "done" ? "● Complete" : "● Idle";
}

function handleEvent(ev) {
  switch (ev.type) {
    case "start":
      if (ev.run_id) {
        try { localStorage.setItem(RUN_LS_KEY, JSON.stringify({ id: ev.run_id, ticker: ev.ticker })); } catch {}
        if (ev.ticker) currentTicker = currentTicker || ev.ticker;
      }
      logLine(`Analyzing ${ev.ticker} as of ${ev.date} — analysts: ${(ev.analysts || []).join(", ")}`);
      break;
    case "status":
      setNodeStatus(ev.agent, ev.status);
      if (ev.status === "in_progress") { setStatus(`${ev.agent}…`); logLine(`${ev.agent} working…`); }
      break;
    case "report":
      addReport(ev.agent, ev.summary, ev.content);
      (ev.flow_to || []).forEach((dst) => flow(ev.agent, dst, ev.summary));
      break;
    case "debate":
      addDebateTurn(ev);
      setStatus(`debate R${ev.round}/${ev.rounds} — ${ev.side}`);
      break;
    case "consensus":
      showConsensus(ev);
      break;
    case "usage":
      updateTokens(ev);
      break;
    case "done":
      logLine(`Decision: ${ev.decision}`);
      renderVerdict(ev);
      if (ev.tokens_in != null) updateTokens(ev);
      setStatus(`done — ${ev.decision}`);
      setCoordLive("done");
      switchReadTab("verdict");
      stopTrackers();
      try { localStorage.removeItem(RUN_LS_KEY); } catch {}   // completed & shown
      break;
    case "error":
      logLine(`Error: ${ev.message}`);
      setStatus("error");
      try { localStorage.removeItem(RUN_LS_KEY); } catch {}
      break;
    case "close":
      endRun();
      break;
  }
}

function endRun() {
  if (sse) { sse.close(); sse = null; }
  stopTrackers();
  runBtn.disabled = !currentTicker;
}

// --------------------------------------------------------------------------- //
// Sidebar navigation between pages
// --------------------------------------------------------------------------- //
let _econLoaded = false, _newsLoaded = false, _btLoaded = false, _pfLoaded = false;
let _coordInit = false;

function gotoPage(page) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
  if (page === "markets" && !_econLoaded) { _econLoaded = true; loadGlobalMarkets(); }
  if (page === "news" && !_newsLoaded) { _newsLoaded = true; loadNews(); }
  if (page === "whale" && !_whaleLoaded) { _whaleLoaded = true; initWhale(); }
  if (page === "calendar" && !_calLoaded) { _calLoaded = true; renderCalendarPage(); }
  if (page === "ai") _chatScroll();
  if (page === "backtester" && !_btLoaded) { _btLoaded = true; initBacktester(); }
  if (page === "portfolio" && !_pfLoaded) { _pfLoaded = true; initPortfolio(); }
  if (page === "coord") initCoordPage();
}

document.querySelector(".nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item"); if (!btn) return;
  gotoPage(btn.dataset.page);
});

// One-time wiring for the Agent Coordination page.
function initCoordPage() {
  if (_coordInit) {
    const ti = document.getElementById("coord-ticker");
    if (ti && currentTicker && !ti.value) ti.value = currentTicker;
    return;
  }
  _coordInit = true;
  buildGraph();  // draw idle collector cards + pipeline
  const ti = document.getElementById("coord-ticker"), sug = document.getElementById("coord-sug");
  if (ti) {
    if (currentTicker) ti.value = currentTicker;
    attachTickerSuggest(ti, sug, (it) => selectTicker(it.symbol));
  }
  // Rebuild the collector cards/pipeline when the selection changes (idle only).
  document.querySelectorAll("#page-coord .coord-analysts-bar input").forEach((cb) =>
    cb.addEventListener("change", () => { if (!sse) buildGraph(); }));
  // Reading-window tabs.
  const rt = document.getElementById("coord-read-tabs");
  if (rt) rt.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (b) switchReadTab(b.dataset.rtab);
  });
}

// "Run agent analysis →" link on the dashboard Overview tab.
document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-goto]"); if (!link) return;
  e.preventDefault(); gotoPage(link.dataset.goto);
});

// --------------------------------------------------------------------------- //
// Analysis sub-tabs (Agent Analysis / Reports / Fundamentals / …)
// --------------------------------------------------------------------------- //
let _fundLoaded = false, _finLoaded = false, _techLoaded = false;
document.getElementById("atabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  const tab = btn.dataset.atab;
  document.querySelectorAll("#atabs button").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".atab-panel").forEach((p) => p.classList.toggle("active", p.id === `atab-${tab}`));
  if (tab === "overview" && currentTicker) loadDashOverview();
  if (tab === "fundamentals" && !_fundLoaded && currentTicker) { _fundLoaded = true; loadFundamentals(); }
  if (tab === "financials" && !_finLoaded && currentTicker) { _finLoaded = true; loadFinancials(); }
  if (tab === "technicals" && !_techLoaded && currentTicker) { _techLoaded = true; loadTechnicals(); }
});

// Dashboard Overview tab — the company introduction (reuses /api/company/overview).
let _dashOvTicker = null;
async function loadDashOverview() {
  const box = document.getElementById("dash-overview"); if (!box || !currentTicker) return;
  if (_dashOvTicker === currentTicker) return;       // already loaded for this ticker
  _dashOvTicker = currentTicker;
  box.innerHTML = `<p class="dash-empty">Loading overview…</p>`;
  let d;
  try { d = await (await fetch(`/api/company/overview?ticker=${encodeURIComponent(currentTicker)}`)).json(); }
  catch { box.innerHTML = `<p class="dash-empty">Overview unavailable.</p>`; return; }
  if (!d || d.error) { box.innerHTML = `<p class="dash-empty">${_esc((d && d.error) || "Overview unavailable.")}</p>`; return; }
  const p = d.profile || {}, px = d.price || {};
  const chg = (px.last != null && px.prev_close) ? (px.last / px.prev_close - 1) * 100 : px.change_pct;
  const nm = document.getElementById("dash-ov-name");
  if (nm) nm.textContent = `${p.name || currentTicker} · ${d.ticker || currentTicker}`;
  box.innerHTML = `
    <div class="ov-top">
      <div class="ov-pxbox">
        <div class="ov-px">${px.last != null ? "$" + px.last.toFixed(2) : "—"} <span class="${chg >= 0 ? "up" : "down"}">${chg != null ? _pctRaw(chg) : ""}</span></div>
        <div class="ov-tags">${p.sector ? `<span class="tag">${_esc(p.sector)}</span>` : ""}${p.industry ? `<span class="tag">${_esc(p.industry)}</span>` : ""}</div>
      </div>
      <div class="ov-keys">
        <div><label>Mkt Cap</label><span>${_fmtBig(p.market_cap)}</span></div>
        <div><label>P/E</label><span>${px.pe != null ? px.pe.toFixed(1) : "—"}</span></div>
        <div><label>52W Range</label><span>${px.fifty_two_low != null ? px.fifty_two_low.toFixed(0) : "—"}–${px.fifty_two_high != null ? px.fifty_two_high.toFixed(0) : "—"}</span></div>
        <div><label>Div Yield</label><span>${px.dividend_yield != null ? px.dividend_yield.toFixed(2) + "%" : "—"}</span></div>
      </div>
    </div>
    ${p.description ? `<div class="ov-sec"><h4>About ${_esc(p.name || currentTicker)}</h4><p class="ov-desc">${_esc(p.description)}</p>
       <div class="ov-meta">${p.website ? `<a href="${_esc(p.website)}" target="_blank" rel="noopener">${_esc(p.website.replace(/^https?:\/\//, ""))}</a>` : ""}${p.employees ? ` · ${p.employees.toLocaleString()} employees` : ""}${p.city ? ` · ${_esc(p.city)}${p.country ? ", " + _esc(p.country) : ""}` : ""}</div></div>` : `<p class="dash-empty">No company description available.</p>`}
    ${d.calendar_summary ? `<div class="ov-sec"><h4>Next events</h4><div class="ov-meta">Earnings <b>${_esc(d.calendar_summary.earnings_date || "—")}</b> · Ex-dividend ${_esc(d.calendar_summary.ex_dividend_date || "—")}</div></div>` : ""}
    <div class="stmt-src">${_esc(d.source || "")}</div>`;
}

// --------------------------------------------------------------------------- //
// Quote header + right rail (overview / insights / per-ticker news)
// --------------------------------------------------------------------------- //
function _fmtBig(n) {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function _fmtPct(p) { return p == null ? "—" : `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`; }
function _setPct(el, p) {
  if (!el) return;
  el.textContent = _fmtPct(p);
  el.className = "ov-val " + (p == null ? "" : p >= 0 ? "up" : "down");
}

async function loadQuote() {
  if (!currentTicker) return;
  let q;
  try { q = await (await fetch(`/api/quote?ticker=${encodeURIComponent(currentTicker)}`)).json(); }
  catch { return; }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("q-symbol", q.symbol || currentTicker);
  set("q-name", q.name || currentTicker);
  const sec = document.getElementById("q-sector");
  if (sec) { if (q.sector) { sec.textContent = q.sector; sec.hidden = false; } else sec.hidden = true; }
  _syncStar();  // refresh the watchlist star for the now-loaded ticker
  if (q.price != null) set("q-last", q.price.toFixed(2));
  const chg = document.getElementById("q-change");
  if (chg && q.change_pct != null) {
    chg.textContent = `${q.change >= 0 ? "▲" : "▼"} ${q.change_pct.toFixed(2)}% (${q.change >= 0 ? "+" : ""}${(q.change ?? 0).toFixed(2)})`;
    chg.className = "q-change " + (q.change_pct >= 0 ? "up" : "down");
  }
  const f2 = (v) => (v == null ? "—" : v.toFixed(2));
  set("q-open", f2(q.open)); set("q-high", f2(q.day_high)); set("q-low", f2(q.day_low));
  set("q-prev", f2(q.prev_close)); set("q-vol", _fmtBig(q.volume)); set("q-mcap", _fmtBig(q.market_cap));

  // Right rail — quick overview
  _setPct(document.getElementById("ov-1d"), q.change_1d);
  _setPct(document.getElementById("ov-5d"), q.change_5d);
  _setPct(document.getElementById("ov-1m"), q.change_1m);
  set("ov-52h", f2(q.week52_high)); set("ov-52l", f2(q.week52_low));
  set("ov-pe", q.pe != null ? q.pe.toFixed(2) : "—");
  // Day range bar
  if (q.day_low != null && q.day_high != null && q.price != null && q.day_high > q.day_low) {
    const pos = Math.min(100, Math.max(0, (q.price - q.day_low) / (q.day_high - q.day_low) * 100));
    const dot = document.getElementById("ov-range-dot");
    const fill = document.getElementById("ov-range-fill");
    if (dot) dot.style.left = pos + "%";
    if (fill) fill.style.width = pos + "%";
    set("ov-range-lo", f2(q.day_low)); set("ov-range-hi", f2(q.day_high));
  }
}

// Shared signal-row renderer (used by both the technical + fundamental panels).
const _SIG_ICON = { bullish: "📈", bearish: "📉", neutral: "⚠️" };
const _SIG_WORD = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" };
function _sigRow(s) {
  return `<div class="sig-row">
      <span class="sig-ico">${_SIG_ICON[s.verdict] || "•"}</span>
      <div class="sig-body"><div class="sig-label">${_esc(s.label)}</div><div class="sig-val">${_esc(s.value)}</div></div>
      <span class="sig-badge ${s.verdict}">${_SIG_WORD[s.verdict] || s.verdict}</span>
    </div>`;
}

async function loadSignals() {
  const box = document.getElementById("ks-tech");
  if (!currentTicker || !box) return;
  box.innerHTML = `<div class="ks-group-h">Technicals</div><p class="dash-empty">Computing signals…</p>`;
  let data;
  try { data = await (await fetch(`/api/signals?ticker=${encodeURIComponent(currentTicker)}`)).json(); }
  catch { box.innerHTML = `<div class="ks-group-h">Technicals</div><p class="dash-empty">Could not compute signals.</p>`; return; }
  const sigs = data.signals || [];
  box.innerHTML = `<div class="ks-group-h">Technicals</div>` +
    (sigs.length ? sigs.map(_sigRow).join("") : `<p class="dash-empty">No signals available.</p>`);
}

let _agentRan = false;
function renderConsensus(c, fromAgents) {
  // The standalone consensus gauge was replaced by the financials histogram;
  // skip silently if its elements aren't present (the debate still shows its
  // own consensus banner during a run).
  if (!document.getElementById("consensus-gauge")) return;
  const pct = c.pct ?? 0;
  // gauge arc: semicircle, 180° sweep
  const g = document.getElementById("consensus-gauge");
  const cx = 100, cy = 100, r = 80;
  const ang = Math.PI * (1 - pct / 100);           // 180°→0°
  const x = cx + r * Math.cos(ang), y = cy - r * Math.sin(ang);
  const seg = (a0, a1, color) => {
    const p0 = `${cx + r * Math.cos(a0)},${cy - r * Math.sin(a0)}`;
    const p1 = `${cx + r * Math.cos(a1)},${cy - r * Math.sin(a1)}`;
    const large = (a0 - a1) > Math.PI ? 1 : 0;
    return `<path d="M ${p0} A ${r} ${r} 0 ${large} 1 ${p1}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>`;
  };
  const PI = Math.PI;
  g.innerHTML =
    seg(PI, PI * 2 / 3, "var(--down)") +
    seg(PI * 2 / 3, PI / 3, "var(--amber)") +
    seg(PI / 3, 0, "var(--up)") +
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="#fff" stroke="var(--bg)" stroke-width="2"/>`;
  document.getElementById("cons-pct").textContent = pct + "%";
  document.getElementById("cons-label").textContent = c.label || "";
  const v = document.getElementById("cons-verdict");
  const strong = pct >= 75 ? "Strong Buy" : pct >= 60 ? "Buy" : pct >= 45 ? "Hold" : pct >= 30 ? "Reduce" : "Sell";
  v.textContent = strong + (fromAgents ? " · agents' verdict" : " · signal baseline");
  v.className = "cons-verdict " + (pct >= 60 ? "good" : pct <= 40 ? "bad" : "mid");
  const bars = document.getElementById("cons-bars");
  if (c.bullish != null) {
    const tot = Math.max(1, (c.bullish + c.neutral + c.bearish));
    bars.innerHTML = [
      ["Bullish", c.bullish, "var(--up)"],
      ["Neutral", c.neutral, "var(--amber)"],
      ["Bearish", c.bearish, "var(--down)"],
    ].map(([lab, n, col]) => `
      <div class="cbar"><span class="cbar-lab">${lab}</span>
        <div class="cbar-track"><div class="cbar-fill" style="width:${n / tot * 100}%;background:${col}"></div></div>
        <span class="cbar-n">${n}</span></div>`).join("");
  }
}

// --------------------------------------------------------------------------- //
// Quarterly financials histogram (bars = $ amount, line = QoQ % change) +
// fundamental key-signals. One fetch feeds both.
// --------------------------------------------------------------------------- //
let _finData = null, _finMetric = "revenue";

async function loadFinChart() {
  const chart = document.getElementById("fin-chart");
  const fund = document.getElementById("ks-fund");
  if (!currentTicker) return;
  if (chart) chart.innerHTML = `<p class="dash-empty">Loading financials…</p>`;
  let d;
  try { d = await (await fetch(`/api/financials?ticker=${encodeURIComponent(currentTicker)}`)).json(); }
  catch {
    if (chart) chart.innerHTML = `<p class="dash-empty">Could not load financials.</p>`;
    return;
  }
  _finData = d;
  if (fund) {
    const sigs = d.signals || [];
    fund.innerHTML = `<div class="ks-group-h">Fundamentals</div>` +
      (sigs.length ? sigs.map(_sigRow).join("") : `<p class="dash-empty">No fundamentals.</p>`);
  }
  _renderFinChart(_finMetric);
}

function _fmtMoney(v) {
  if (v == null) return "—";
  const s = v < 0 ? "-" : "", a = Math.abs(v);
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9)  return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6)  return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3)  return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(0)}`;
}

// --------------------------------------------------------------------------- //
// AI Analysis workspace — OpenBB-style tabbed company terminal (left) + chat (right).
// Tabs: Overview · Financials · Technical · Comparison · Ownership · Calendar · Estimates.
// --------------------------------------------------------------------------- //
let _aiTicker = "", _aiTab = "overview", _stmtType = "income", _stmtPeriod = "annual";

function _aiBody() { return document.getElementById("ai-tabbody"); }
function _pctRaw(v)  { return v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`; }  // already a percent
function _pctFrac(v) { return v == null ? "—" : `${(v * 100).toFixed(1)}%`; }              // a 0..1 fraction
function _numOrDash(v) { return v == null ? "—" : (typeof v === "number" ? v.toFixed(2) : _esc(String(v))); }
function _fmtBig(v) {
  if (v == null) return "—";
  const s = v < 0 ? "-" : "", a = Math.abs(v);
  if (a >= 1e12) return `${s}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9)  return `${s}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6)  return `${s}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3)  return `${s}${(a / 1e3).toFixed(1)}K`;
  return `${s}${a.toFixed(0)}`;
}
function _stmtPeriodLabel(end, period) {
  const dt = new Date(end + "T00:00:00");
  if (period === "annual") return "FY" + String(dt.getFullYear()).slice(2);
  const q = Math.floor(dt.getMonth() / 3) + 1;
  return `Q${q} '${String(dt.getFullYear()).slice(2)}`;
}
function _stmtCell(key, v) {
  if (v == null) return `<td class="dim">—</td>`;
  if (key.startsWith("eps")) return `<td>${v.toFixed(2)}</td>`;
  return `<td class="${v < 0 ? "neg" : ""}">${_fmtMoney(v)}</td>`;
}
function _estPeriod(p) {
  return ({ "0q": "Current Qtr", "+1q": "Next Qtr", "0y": "Current Yr", "+1y": "Next Yr",
            "-1q": "−1 Qtr", "+5y": "+5Y", "-5y": "−5Y" })[p] || p;
}

// ---- ticker selector (own ticker so the workspace runs standalone) ----
(function () {
  const input = document.getElementById("ai-ticker");
  const sug = document.getElementById("ai-sug");
  if (!input) return;
  const go = (sym) => {
    _aiTicker = (sym || "").trim().toUpperCase();
    if (_aiTicker) input.value = _aiTicker;
    loadAiTab(_aiTab);
  };
  attachTickerSuggest(input, sug, (it) => go(it.symbol));
  document.getElementById("ai-symform").addEventListener("submit", (e) => {
    e.preventDefault(); go(input.value.split(/\s|—/)[0]);
  });
})();

// ---- tab bar + delegated Financials sub-controls ----
document.getElementById("ai-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  document.querySelectorAll("#ai-tabs button").forEach((x) => x.classList.toggle("active", x === b));
  _aiTab = b.dataset.tab;
  loadAiTab(_aiTab);
});
document.getElementById("ai-tabbody").addEventListener("click", (e) => {
  const st = e.target.closest("button[data-stmt]");
  const pe = e.target.closest("button[data-period]");
  if (st) { _stmtType = st.dataset.stmt; renderFinancialsTab(); }
  else if (pe) { _stmtPeriod = pe.dataset.period; renderFinancialsTab(); }
});

async function loadAiTab(tab) {
  const body = _aiBody(); if (!body) return;
  if (!_aiTicker) { body.innerHTML = `<p class="dash-empty">Enter a ticker to load company analysis…</p>`; return; }
  body.innerHTML = `<p class="dash-empty">Loading…</p>`;
  try {
    if (tab === "overview")   return renderOverview();
    if (tab === "financials") return renderFinancialsTab();
    if (tab === "technical")  return renderTechnical();
    if (tab === "comparison") return renderComparison();
    if (tab === "ownership")  return renderOwnership();
    if (tab === "calendar")   return renderCalendar();
    if (tab === "estimates")  return renderEstimates();
  } catch { body.innerHTML = `<p class="dash-empty">Could not load this tab.</p>`; }
}
async function _aiFetch(path) {
  return (await fetch(`/api/company/${path}?ticker=${encodeURIComponent(_aiTicker)}`)).json();
}

// ---- shared widgets: analyst price-target bar + recommendation bar ----
function _ptBar(pt, current) {
  const lo = pt.low, hi = pt.high, mean = pt.mean, cur = current != null ? current : pt.current;
  if (lo == null || hi == null || hi <= lo) {
    return `<div class="ov-meta">Mean ${mean != null ? "$" + mean.toFixed(2) : "—"} · low ${lo != null ? "$" + lo.toFixed(2) : "—"} · high ${hi != null ? "$" + hi.toFixed(2) : "—"}</div>`;
  }
  const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  return `<div class="pt-bar"><div class="pt-track">
      ${mean != null ? `<i class="pt-mean" style="left:${pos(mean)}%"></i>` : ""}
      ${cur != null ? `<i class="pt-cur" style="left:${pos(cur)}%"></i>` : ""}</div>
    <div class="pt-ends"><span>$${lo.toFixed(0)}</span>
      <span class="pt-mid">mean $${mean != null ? mean.toFixed(0) : "—"}${cur != null ? ` · now $${cur.toFixed(0)}` : ""}</span>
      <span>$${hi.toFixed(0)}</span></div></div>`;
}
function _recBar(rec) {
  const order = [["strongBuy", "Strong Buy", "sb"], ["buy", "Buy", "b"], ["hold", "Hold", "h"],
                 ["sell", "Sell", "s"], ["strongSell", "Strong Sell", "ss"]];
  const total = order.reduce((a, [k]) => a + (rec[k] || 0), 0) || 1;
  const seg = order.map(([k, , c]) => rec[k] ? `<i class="rec-seg ${c}" style="width:${(rec[k] / total) * 100}%" title="${k}: ${rec[k]}"></i>` : "").join("");
  const leg = order.filter(([k]) => rec[k]).map(([k, lab, c]) => `<span class="rec-lg"><i class="${c}"></i>${lab} ${rec[k]}</span>`).join("");
  return `<div class="rec-bar">${seg}</div><div class="rec-legend">${leg}</div>`;
}

// ---- Overview ----
async function renderOverview() {
  const d = await _aiFetch("overview");
  const body = _aiBody();
  if (d.error) { body.innerHTML = `<p class="dash-empty">${_esc(d.error)}</p>`; return; }
  const p = d.profile, px = d.price;
  const chg = (px.last != null && px.prev_close) ? (px.last / px.prev_close - 1) * 100 : px.change_pct;
  const nm = document.getElementById("ai-co-name");
  if (nm) nm.innerHTML = `<i data-lucide="building-2"></i> ${_esc(p.name)} · ${_esc(d.ticker)}`;
  body.innerHTML = `
    <div class="ov-top">
      <div class="ov-pxbox">
        <div class="ov-px">${px.last != null ? "$" + px.last.toFixed(2) : "—"} <span class="${chg >= 0 ? "up" : "down"}">${_pctRaw(chg)}</span></div>
        <div class="ov-tags">${p.sector ? `<span class="tag">${_esc(p.sector)}</span>` : ""}${p.industry ? `<span class="tag">${_esc(p.industry)}</span>` : ""}</div>
      </div>
      <div class="ov-keys">
        <div><label>Mkt Cap</label><span>${_fmtBig(p.market_cap)}</span></div>
        <div><label>P/E</label><span>${px.pe != null ? px.pe.toFixed(1) : "—"}</span></div>
        <div><label>52W Range</label><span>${px.fifty_two_low != null ? px.fifty_two_low.toFixed(0) : "—"}–${px.fifty_two_high != null ? px.fifty_two_high.toFixed(0) : "—"}</span></div>
        <div><label>Div Yield</label><span>${px.dividend_yield != null ? px.dividend_yield.toFixed(2) + "%" : "—"}</span></div>
      </div>
    </div>
    <div id="ai-ov-chart" class="ov-chart"></div>
    ${d.estimate_summary ? `<div class="ov-sec"><h4>Analyst price target</h4>${_ptBar(d.estimate_summary, px.last)}</div>` : ""}
    ${d.recommendation ? `<div class="ov-sec"><h4>Recommendation</h4>${_recBar(d.recommendation)}</div>` : ""}
    ${p.description ? `<div class="ov-sec"><h4>About ${_esc(p.name)}</h4><p class="ov-desc">${_esc(p.description)}</p>
       <div class="ov-meta">${p.website ? `<a href="${_esc(p.website)}" target="_blank" rel="noopener">${_esc(p.website.replace(/^https?:\/\//, ""))}</a>` : ""}${p.employees ? ` · ${p.employees.toLocaleString()} employees` : ""}${p.city ? ` · ${_esc(p.city)}${p.country ? ", " + _esc(p.country) : ""}` : ""}</div></div>` : ""}
    ${d.calendar_summary ? `<div class="ov-sec"><h4>Next events</h4><div class="ov-meta">Earnings <b>${_esc(d.calendar_summary.earnings_date || "—")}</b> · Ex-dividend ${_esc(d.calendar_summary.ex_dividend_date || "—")}</div></div>` : ""}
    <div class="stmt-src">${_esc(d.source || "")}</div>`;
  if (window.lucide) lucide.createIcons();
  _ovPriceChart();
}
async function _ovPriceChart() {
  try {
    const d = await (await fetch(`/api/prices?ticker=${encodeURIComponent(_aiTicker)}&range=1y`)).json();
    const c = d.candles || [];
    if (!c.length) return;
    plotLines("ai-ov-chart", [{ name: _aiTicker, x: c.map((p) => new Date(p.t)), y: c.map((p) => p.c), color: "#3b82f6", fill: true }], { yprefix: "$" });
  } catch { /* no chart */ }
}

// ---- Financials (raw SEC XBRL) ----
async function renderFinancialsTab() {
  const body = _aiBody();
  const seg = (arr, sel, attr) => arr.map(([v, t]) => `<button class="${v === sel ? "active" : ""}" data-${attr}="${v}">${t}</button>`).join("");
  const controls = `<div class="ai-data-bar">
    <div class="stmt-tabs">${seg([["income", "Income"], ["balance", "Balance Sheet"], ["cashflow", "Cash Flow"]], _stmtType, "stmt")}</div>
    <div class="stmt-period">${seg([["annual", "Annual"], ["quarter", "Quarter"]], _stmtPeriod, "period")}</div>
  </div>`;
  body.innerHTML = controls + `<p class="dash-empty">Loading ${_stmtType}…</p>`;
  let d;
  try { d = await (await fetch(`/api/statements?ticker=${encodeURIComponent(_aiTicker)}&statement=${_stmtType}&period=${_stmtPeriod}`)).json(); }
  catch { body.innerHTML = controls + `<p class="dash-empty">Could not load statements.</p>`; return; }
  let table;
  if (d.error || !(d.rows || []).length) table = `<p class="dash-empty">${_esc(d.error || "No statement data.")}</p>`;
  else {
    const heads = d.periods.map((p) => `<th>${_stmtPeriodLabel(p, d.period)}</th>`).join("");
    const rows = d.rows.map((r) => `<tr><th class="stmt-rowlabel">${_esc(r.label)}</th>${r.values.map((v) => _stmtCell(r.key, v)).join("")}</tr>`).join("");
    table = `<div class="stmt-table"><table class="stmt-tbl"><thead><tr><th></th>${heads}</tr></thead><tbody>${rows}</tbody></table></div><div class="stmt-src">${_esc(d.source)} · ${_esc(d.name || "")}</div>`;
  }
  body.innerHTML = controls + table;
}

// ---- Technical Analysis (mechanical signals) ----
async function renderTechnical() {
  const body = _aiBody();
  let d;
  try { d = await (await fetch(`/api/signals?ticker=${encodeURIComponent(_aiTicker)}`)).json(); }
  catch { body.innerHTML = `<p class="dash-empty">Could not load technicals.</p>`; return; }
  const sigs = d.signals || [], c = d.consensus || {};
  if (!sigs.length) { body.innerHTML = `<p class="dash-empty">No technical signals.</p>`; return; }
  const cls = (c.label || "").toLowerCase();
  body.innerHTML = `
    ${c.label ? `<div class="tech-consensus ${cls}"><span class="tc-label">${_esc(c.label)}</span><span class="tc-tally">${c.bullish || 0}↑ · ${c.neutral || 0}– · ${c.bearish || 0}↓</span></div>` : ""}
    <table class="tech-tbl">${sigs.map((s) => `<tr><td class="tech-lab">${_esc(s.label)}</td><td class="tech-val">${_esc(String(s.value))}</td><td><span class="vdot ${s.verdict}">${_esc(s.verdict)}</span></td></tr>`).join("")}</table>
    <div class="stmt-src">Mechanical indicators · live</div>`;
}

// ---- Comparison Analysis (peers) ----
async function renderComparison() {
  const d = await _aiFetch("peers");
  const body = _aiBody();
  const rows = d.rows || [];
  if (!rows.length) { body.innerHTML = `<p class="dash-empty">${_esc(d.error || "No peer data.")}</p>`; return; }
  body.innerHTML = `<div class="cmp-wrap"><table class="cmp-tbl">
    <thead><tr><th>Symbol</th><th>Price</th><th>Chg%</th><th>Mkt Cap</th><th>P/E</th><th>Margin</th><th>Rev Gr</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r.is_target ? "cmp-target" : ""}">
      <td class="cmp-sym">${_esc(r.symbol)}</td>
      <td>${r.price != null ? "$" + r.price.toFixed(2) : "—"}</td>
      <td class="${(r.change_pct || 0) >= 0 ? "up" : "down"}">${_pctRaw(r.change_pct)}</td>
      <td>${_fmtBig(r.market_cap)}</td>
      <td>${r.pe != null ? r.pe.toFixed(1) : "—"}</td>
      <td>${_pctFrac(r.profit_margin)}</td>
      <td>${_pctFrac(r.revenue_growth)}</td></tr>`).join("")}</tbody></table></div>
    <div class="stmt-src">${_esc(d.source || "")}</div>`;
}

// ---- Ownership ----
async function renderOwnership() {
  const d = await _aiFetch("ownership");
  const body = _aiBody();
  const inst = d.institutional || [], maj = d.major || {}, ins = d.insiders || [];
  const majRow = (label, key) => maj[key] != null ? `<div><label>${label}</label><span>${(maj[key] * 100).toFixed(1)}%</span></div>` : "";
  body.innerHTML = `
    <div class="own-keys">
      ${majRow("Insiders", "insidersPercentHeld")}
      ${majRow("Institutions", "institutionsPercentHeld")}
      ${majRow("Inst. of float", "institutionsFloatPercentHeld")}
      ${maj.institutionsCount != null ? `<div><label>Inst. holders</label><span>${maj.institutionsCount.toLocaleString()}</span></div>` : ""}
    </div>
    <h4 class="own-h">Top institutional holders</h4>
    ${inst.length ? `<table class="own-tbl"><thead><tr><th>Holder</th><th>Shares</th><th>% Held</th><th>Value</th></tr></thead><tbody>${inst.map((h) => `<tr><td class="own-name">${_esc(h.holder || "")}</td><td>${_fmtBig(h.shares)}</td><td>${_pctFrac(h.pct_held)}</td><td>${_fmtMoney(h.value)}</td></tr>`).join("")}</tbody></table>` : `<p class="dash-empty">No institutional data.</p>`}
    <h4 class="own-h">Recent insider transactions</h4>
    ${ins.length ? `<table class="own-tbl"><thead><tr><th>Insider</th><th>Transaction</th><th>Shares</th><th>Value</th></tr></thead><tbody>${ins.map((t) => `<tr><td class="own-name">${_esc(t.insider || "")}<span class="own-pos">${_esc(t.position || "")}</span></td><td>${_esc(t.transaction || "")}</td><td>${_fmtBig(t.shares)}</td><td>${_fmtMoney(t.value)}</td></tr>`).join("")}</tbody></table>` : `<p class="dash-empty">No insider activity.</p>`}
    <div class="stmt-src">${_esc(d.source || "")}</div>`;
}

// ---- Company Calendar ----
async function renderCalendar() {
  const d = await _aiFetch("calendar");
  const body = _aiBody();
  const n = d.next || {}, hist = d.earnings_history || [], div = d.dividends || [], spl = d.splits || [];
  body.innerHTML = `
    <div class="cal-next">
      <div><label>Next earnings</label><span>${_esc(n.earnings_date || "—")}</span></div>
      <div><label>Ex-dividend</label><span>${_esc(n.ex_dividend_date || "—")}</span></div>
      <div><label>Est. EPS</label><span>${n.earnings_avg != null ? n.earnings_avg.toFixed(2) : "—"}</span></div>
    </div>
    <h4 class="own-h">Earnings history</h4>
    ${hist.length ? `<table class="own-tbl"><thead><tr><th>Date</th><th>EPS est.</th><th>Reported</th><th>Surprise</th></tr></thead><tbody>${hist.map((r) => `<tr><td>${_esc(r.date)}</td><td>${_numOrDash(r["EPS Estimate"])}</td><td>${_numOrDash(r["Reported EPS"])}</td><td class="${(r["Surprise(%)"] || 0) >= 0 ? "up" : "down"}">${r["Surprise(%)"] != null ? r["Surprise(%)"].toFixed(1) + "%" : "—"}</td></tr>`).join("")}</tbody></table>` : `<p class="dash-empty">No earnings history.</p>`}
    ${div.length ? `<h4 class="own-h">Recent dividends</h4><div class="cal-chips">${div.slice(0, 8).map((x) => `<span class="cal-chip">${_esc(x.date)} <b>$${(x.value || 0).toFixed(3)}</b></span>`).join("")}</div>` : ""}
    ${spl.length ? `<h4 class="own-h">Stock splits</h4><div class="cal-chips">${spl.map((x) => `<span class="cal-chip">${_esc(x.date)} <b>${x.value}:1</b></span>`).join("")}</div>` : ""}
    <div class="stmt-src">${_esc(d.source || "")}</div>`;
}

// ---- Estimates ----
async function renderEstimates() {
  const d = await _aiFetch("estimates");
  const body = _aiBody();
  const estTbl = (title, recs, cols) => {
    if (!recs || !recs.length) return "";
    const use = cols.filter((c) => recs.some((r) => r[c.k] != null));
    return `<h4 class="own-h">${title}</h4><table class="own-tbl"><thead><tr><th>Period</th>${use.map((c) => `<th>${c.t}</th>`).join("")}</tr></thead><tbody>${recs.map((r) => `<tr><td>${_esc(_estPeriod(r.period))}</td>${use.map((c) => `<td>${c.f(r[c.k])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  };
  body.innerHTML = `
    ${d.price_target ? `<div class="ov-sec"><h4>Price target</h4>${_ptBar(d.price_target, d.price_target.current)}</div>` : ""}
    ${d.recommendation ? `<div class="ov-sec"><h4>Recommendation</h4>${_recBar(d.recommendation)}</div>` : ""}
    ${estTbl("EPS estimate", d.earnings_estimate, [{ k: "avg", t: "Avg", f: _numOrDash }, { k: "low", t: "Low", f: _numOrDash }, { k: "high", t: "High", f: _numOrDash }, { k: "numberOfAnalysts", t: "Analysts", f: _numOrDash }, { k: "growth", t: "Growth", f: _pctFrac }])}
    ${estTbl("Revenue estimate", d.revenue_estimate, [{ k: "avg", t: "Avg", f: _fmtBig }, { k: "low", t: "Low", f: _fmtBig }, { k: "high", t: "High", f: _fmtBig }, { k: "growth", t: "Growth", f: _pctFrac }])}
    ${estTbl("Growth estimates", d.growth_estimates, [{ k: "stockTrend", t: "Stock", f: _pctFrac }, { k: "indexTrend", t: "Index", f: _pctFrac }])}
    <div class="stmt-src">${_esc(d.source || "")}</div>`;
}
function _qLabel(date) {
  // 'YYYY-MM-DD' -> "Mon'YY"
  const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const p = String(date || "").split("-");
  if (p.length < 2) return date || "";
  return `${m[(+p[1] - 1) % 12]}'${p[0].slice(2)}`;
}

function _renderFinChart(metric) {
  _finMetric = metric;
  const chart = document.getElementById("fin-chart");
  if (!chart || !_finData) return;
  const qs = (_finData.quarters || []).filter((q) => q[metric] != null);
  if (!qs.length) { chart.innerHTML = `<p class="dash-empty">No data for this metric.</p>`; return; }

  const vals = qs.map((q) => q[metric]);
  const n = vals.length;
  // QoQ % change (first quarter has no prior → null)
  const qoq = vals.map((v, i) =>
    i === 0 || !vals[i - 1] ? null : ((v - vals[i - 1]) / Math.abs(vals[i - 1])) * 100);

  const W = 560, H = 300, padL = 56, padR = 48, padT = 20, padB = 36;
  const x0 = padL, x1 = W - padR, plotW = x1 - x0, plotH = H - padT - padB, yBase = padT + plotH;
  const maxV = Math.max(0, ...vals), minV = Math.min(0, ...vals), span = (maxV - minV) || 1;
  const yMoney = (v) => yBase - ((v - minV) / span) * plotH;
  const cx = (i) => x0 + plotW * (i + 0.5) / n;
  const bw = Math.min(48, (plotW / n) * 0.5);

  // Secondary (%) axis: 0% at plot middle, symmetric.
  const ps = qoq.filter((p) => p != null).map(Math.abs);
  const pMax = ps.length ? Math.max(5, Math.ceil(Math.max(...ps) / 5) * 5) : 5;
  const midY = padT + plotH / 2, half = (plotH / 2) * 0.82;
  const yPct = (p) => midY - (p / pMax) * half;

  const zeroY = yMoney(0);
  const bars = vals.map((v, i) => {
    const y = yMoney(v), top = Math.min(y, zeroY), h = Math.max(1, Math.abs(y - zeroY));
    return `<rect class="fin-bar ${v < 0 ? "neg" : ""}" x="${(cx(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${qs[i].date}: ${_fmtMoney(v)}</title></rect>`;
  }).join("");

  const pts = qoq.map((p, i) => (p == null ? null : `${cx(i).toFixed(1)},${yPct(p).toFixed(1)}`)).filter(Boolean).join(" ");
  const line = pts ? `<polyline class="fin-qline" points="${pts}"/>` : "";
  const dots = qoq.map((p, i) => p == null ? "" :
    `<circle class="fin-qdot ${p >= 0 ? "up" : "down"}" cx="${cx(i).toFixed(1)}" cy="${yPct(p).toFixed(1)}" r="3.5"><title>QoQ ${p >= 0 ? "+" : ""}${p.toFixed(1)}%</title></circle>`).join("");
  const plab = qoq.map((p, i) => p == null ? "" :
    `<text class="fin-qpct ${p >= 0 ? "up" : "down"}" x="${cx(i).toFixed(1)}" y="${(yPct(p) - 7).toFixed(1)}">${p >= 0 ? "+" : ""}${p.toFixed(0)}%</text>`).join("");

  // axes: left = money (top / 0 / bottom), right = % (+pMax / 0 / -pMax)
  const yticks =
    `<text class="fin-axis left" x="${x0 - 6}" y="${(yMoney(maxV) + 3).toFixed(1)}">${_fmtMoney(maxV)}</text>` +
    (minV < 0 ? `<text class="fin-axis left" x="${x0 - 6}" y="${(zeroY + 3).toFixed(1)}">$0</text>` : "") +
    `<text class="fin-axis left" x="${x0 - 6}" y="${(yMoney(minV) + 3).toFixed(1)}">${_fmtMoney(minV)}</text>` +
    `<text class="fin-axis right" x="${x1 + 6}" y="${(yPct(pMax) + 3).toFixed(1)}">+${pMax}%</text>` +
    `<text class="fin-axis right" x="${x1 + 6}" y="${(midY + 3).toFixed(1)}">0%</text>` +
    `<text class="fin-axis right" x="${x1 + 6}" y="${(yPct(-pMax) + 3).toFixed(1)}">-${pMax}%</text>`;
  const grid = `<line class="fin-grid" x1="${x0}" y1="${midY.toFixed(1)}" x2="${x1}" y2="${midY.toFixed(1)}"/>` +
    `<line class="fin-grid" x1="${x0}" y1="${zeroY.toFixed(1)}" x2="${x1}" y2="${zeroY.toFixed(1)}"/>`;
  const xlabs = qs.map((q, i) => `<text class="fin-xlab" x="${cx(i).toFixed(1)}" y="${(yBase + 16).toFixed(1)}">${_qLabel(q.date)}</text>`).join("");

  chart.innerHTML =
    `<svg class="fin-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${grid}${bars}${line}${dots}${plab}${yticks}${xlabs}</svg>`;
}

document.getElementById("fin-toggle")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-metric]");
  if (!btn) return;
  document.querySelectorAll("#fin-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
  _renderFinChart(btn.dataset.metric);
});

async function loadInsights() {
  if (!currentTicker) return;
  let d;
  try { d = await (await fetch(`/api/insights?ticker=${encodeURIComponent(currentTicker)}`)).json(); }
  catch { return; }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const tagClass = (t) => /pos|bull/i.test(t) ? "tag-bull" : /neg|bear/i.test(t) ? "tag-bear" : "tag-neutral";
  const tt = document.getElementById("ins-trend-tag");
  if (tt && d.trend) { tt.textContent = d.trend; tt.className = tagClass(d.trend); }
  set("ins-trend", d.trend_note || "—");
  set("ins-support", d.support != null ? d.support : "—");
  set("ins-support-d", d.support_note || "");
  set("ins-resistance", d.resistance != null ? d.resistance : "—");
  set("ins-resistance-d", d.resistance_note || "");
  const ot = document.getElementById("ins-outlook-tag");
  if (ot && d.outlook) { ot.textContent = d.outlook; ot.className = tagClass(d.outlook); }
  if (d.confidence != null) {
    const pct = Math.round(d.confidence * 100);
    set("ins-conf", `AI confidence: ${pct}%`);
    const fill = document.getElementById("ins-conf-fill");
    if (fill) fill.style.width = pct + "%";
  }
}

async function loadTickerNews() {
  const list = document.getElementById("tnews-list");
  if (!currentTicker || !list) return;
  list.innerHTML = `<p class="dash-empty">Loading news…</p>`;
  let data;
  try { data = await (await fetch(`/api/ticker-news?ticker=${encodeURIComponent(currentTicker)}&limit=6`)).json(); }
  catch { list.innerHTML = `<p class="dash-empty">Could not load news.</p>`; return; }
  const news = data.news || [];
  if (!news.length) { list.innerHTML = `<p class="dash-empty">No recent news.</p>`; return; }
  list.innerHTML = news.map((n) => `
    <a class="news-item" href="${n.link || "#"}" target="_blank" rel="noopener">
      ${n.thumbnail ? `<img class="news-thumb" src="${_esc(n.thumbnail)}" loading="lazy" alt="" onerror="this.onerror=null;this.outerHTML='<div class=\\'news-thumb ph\\'></div>'" />` : `<div class="news-thumb ph"></div>`}
      <div class="news-body"><div class="news-title">${_esc(n.title)}</div>
        <div class="news-meta"><span>${_esc(n.publisher || "")}</span><span>${_relTime(n.published)}</span></div></div>
    </a>`).join("");
}
document.getElementById("tnews-refresh").addEventListener("click", loadTickerNews);

// --- Fundamentals / Financials / Technicals (lazy data tabs) ----------------
async function loadFundamentals() {
  const el = document.getElementById("fund-table");
  if (!el) return;
  if (!currentTicker) { el.innerHTML = `<p class="dash-empty">Select a ticker to load fundamentals.</p>`; return; }
  el.innerHTML = `<p class="dash-empty">Loading fundamentals…</p>`;
  try {
    const d = await (await fetch(`/api/signals?ticker=${encodeURIComponent(currentTicker)}`)).json();
    const sigs = d.signals || [];
    if (!sigs.length) { el.innerHTML = `<p class="dash-empty">No data available.</p>`; return; }
    const word = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" };
    const rows = sigs.map((s) => `
      <tr>
        <td class="kv-metric">${_esc(s.label)}</td>
        <td class="kv-value">${_esc(s.value)}</td>
        <td><span class="sig-badge ${_esc(s.verdict)}">${word[s.verdict] || _esc(s.verdict)}</span></td>
      </tr>`).join("");
    const c = d.consensus;
    const summary = c ? `<div class="kv-consensus">
        <span class="sig-badge ${_esc((c.label || "").toLowerCase())}">${_esc(c.label)} · ${c.pct}%</span>
        <span class="dim">${c.bullish} bullish · ${c.neutral} neutral · ${c.bearish} bearish</span>
      </div>` : "";
    el.innerHTML = summary + `<table class="kv-table">
        <thead><tr><th>Metric</th><th>Value</th><th>Signal</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
  } catch {
    el.innerHTML = `<p class="dash-empty">Could not load fundamentals.</p>`;
  }
}
function loadFinancials() { document.getElementById("fin-table").innerHTML = `<p class="dash-empty">Run the Fundamentals analyst (agents) for full statements.</p>`; }
function loadTechnicals() { loadSignals(); document.getElementById("tech-table").innerHTML = `<p class="dash-empty">See Key Signals in the Agent Analysis tab for live technicals.</p>`; }

// --- Economy ---------------------------------------------------------------
function _fmtVal(v, unit) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (unit === "%" || unit === "pp") return n.toFixed(2) + (unit === "pp" ? " pp" : "%");
  if (unit === "$") return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function _sparkline(history) {
  if (!history || history.length < 2) return "";
  const vals = history.map((h) => h.value);
  const min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1;
  const W = 120, H = 28;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - min) / rng) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
       + `<polyline points="${pts}" fill="none" stroke="${up ? "var(--up)" : "var(--down)"}" stroke-width="1.5"/></svg>`;
}
function _renderCard(c) {
  // Derive the change from the SAME window the sparkline plots (first vs last of
  // history) so the arrow, %, color, and trendline shape always agree. Falls
  // back to the single-step change if history is unavailable.
  const hist = c.history || [];
  let change = c.change, pct = c.pct_change;
  if (hist.length >= 2) {
    const first = hist[0].value, last = hist[hist.length - 1].value;
    change = last - first;
    pct = first ? (change / first * 100) : null;
  }
  let chHtml = "";
  if (change !== null && change !== undefined) {
    const good = c.good_down ? change < 0 : change > 0;
    const arrow = change > 0 ? "▲" : (change < 0 ? "▼" : "•");
    const pctStr = (pct !== null && pct !== undefined) ? ` (${pct > 0 ? "+" : ""}${pct.toFixed(2)}%)` : "";
    chHtml = `<span class="econ-chg ${good ? "good" : "bad"}">${arrow} ${_fmtVal(Math.abs(change), c.unit)}${pctStr}</span>`;
  }
  return `<div class="econ-card-item" title="FRED: ${c.series || ""}">
    <div class="econ-top"><span class="econ-label">${c.label}</span>${_sparkline(c.history)}</div>
    <div class="econ-val">${_fmtVal(c.value, c.unit)}</div>
    <div class="econ-meta">${chHtml}<span class="econ-asof">${c.as_of || ""}</span></div>
  </div>`;
}
async function loadEconomy() {
  const grid = document.getElementById("econ-grid");
  grid.innerHTML = `<p class="dash-empty">Loading economic indicators…</p>`;
  try {
    const data = await (await fetch("/api/economy")).json();
    const groups = data.groups || {};
    let html = "";
    for (const [group, cards] of Object.entries(groups)) {
      html += `<div class="econ-group"><h3>${group}</h3><div class="econ-cards">`
            + cards.map(_renderCard).join("") + `</div></div>`;
    }
    grid.innerHTML = html || `<p class="dash-empty">No data.</p>`;
  } catch {
    grid.innerHTML = `<p class="dash-empty">Could not load economic data.</p>`;
  }
}
document.getElementById("econ-refresh")?.addEventListener("click", loadEconomy);

// =========================================================================== //
// Global Markets terminal (Markets page) — macro "decision dashboard".
// =========================================================================== //
let _gmHmData = null, _gmHmMetric = "growth", _gmClockTimer = null;

async function _gmFetch(panel) {
  try { return await (await fetch(`/api/global/${panel}`)).json(); }
  catch { return { rows: [], error: "fetch failed" }; }
}
function _flag(cc) {
  if (!cc || cc.length !== 2) return "";
  try { return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))); }
  catch { return ""; }
}
function _sparkSvg(arr, up, w = 64, h = 22) {
  if (!arr || arr.length < 2) return "";
  const lo = Math.min(...arr), hi = Math.max(...arr), span = (hi - lo) || 1;
  const pts = arr.map((v, i) => `${(i / (arr.length - 1) * w).toFixed(1)},${(h - ((v - lo) / span) * h).toFixed(1)}`).join(" ");
  return `<svg class="sparkline ${up ? "up" : "down"}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
}

function loadGlobalMarkets() {
  _startGmClock();
  renderGmRegime();
  renderGmIndices();
  renderGmBonds();
  renderGmList("gm-commodities", "commodities");
  renderGmList("gm-fx", "fx");
  renderGmList("gm-risk", "risk");
  renderGmFlows();
  loadGmHeatmap();
}

async function renderGmRegime() {
  const el = document.getElementById("gm-regime");
  const d = await _gmFetch("regime");
  const cards = d.cards || [];
  if (!cards.length) { el.innerHTML = `<p class="dash-empty">Regime unavailable.</p>`; return; }
  const ICON = { Growth: "trending-up", Inflation: "flame", Liquidity: "droplet", "Risk Appetite": "activity", Dollar: "dollar-sign" };
  el.innerHTML = cards.map((c) => {
    const cls = c.score > 0.15 ? "pos" : c.score < -0.15 ? "neg" : "neu";
    return `<div class="gm-rc ${cls}">
      <div class="gm-rc-ico"><i data-lucide="${ICON[c.key] || "gauge"}"></i></div>
      <div class="gm-rc-body">
        <label>${_esc(c.key)}</label>
        <span class="gm-rc-status">${_esc(c.status)} ›</span>
        <span class="gm-rc-score">${c.score >= 0 ? "+" : ""}${c.score.toFixed(1)}</span>
      </div></div>`;
  }).join("");
  if (window.lucide) lucide.createIcons();
}

async function renderGmIndices() {
  const el = document.getElementById("gm-indices");
  const d = await _gmFetch("indices");
  const rows = d.rows || [];
  if (!rows.length) { el.innerHTML = `<p class="dash-empty">Indices unavailable.</p>`; return; }
  el.innerHTML = `<div class="gm-ix-head"><span>Index</span><span>Value</span><span></span><span>1D</span><span>YTD</span></div>` +
    rows.map((r) => `<div class="gm-ix-row">
      <span class="gm-ix-name">${_esc(r.label)}</span>
      <span class="gm-ix-val">${r.value != null ? r.value.toLocaleString() : "—"}</span>
      <span class="gm-spark">${_sparkSvg(r.spark, (r.change_pct || 0) >= 0)}</span>
      <span class="${(r.change_pct || 0) >= 0 ? "up" : "down"}">${_pctRaw(r.change_pct)}</span>
      <span class="${(r.ytd_pct || 0) >= 0 ? "up" : "down"}">${_pctRaw(r.ytd_pct)}</span>
    </div>`).join("");
}

async function renderGmBonds() {
  const el = document.getElementById("gm-bonds");
  const d = await _gmFetch("bonds");
  const rows = d.rows || [];
  if (!rows.length) { el.innerHTML = `<p class="dash-empty">Bond data unavailable.</p>`; return; }
  el.innerHTML = `<div class="gm-bond-head"><span>Country</span><span>Yield</span><span>Δ bp</span></div>` +
    rows.map((r) => `<div class="gm-bond-row">
      <span class="gm-bond-c">${_flag(r.code)} ${_esc(r.label)}</span>
      <span class="gm-bond-y">${r.yield != null ? r.yield.toFixed(2) + "%" : "—"}</span>
      <span class="${(r.change_bp || 0) >= 0 ? "up" : "down"}">${r.change_bp != null ? (r.change_bp >= 0 ? "+" : "") + r.change_bp.toFixed(1) : "—"}</span>
    </div>`).join("");
}

async function renderGmList(elId, panel) {
  const el = document.getElementById(elId);
  const d = await _gmFetch(panel);
  const rows = d.rows || [];
  if (!rows.length) { el.innerHTML = `<p class="dash-empty">Unavailable.</p>`; return; }
  el.innerHTML = rows.map((r) => `<div class="gm-li-row">
    <span class="gm-li-name">${_esc(r.label)}</span>
    <span class="gm-li-val">${r.value != null ? r.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</span>
    <span class="gm-spark">${_sparkSvg(r.spark, (r.change_pct || 0) >= 0)}</span>
    <span class="${(r.change_pct || 0) >= 0 ? "up" : "down"}">${_pctRaw(r.change_pct)}</span>
  </div>`).join("");
}

async function renderGmFlows() {
  const el = document.getElementById("gm-flows");
  const d = await _gmFetch("flows");
  const rows = d.rows || [];
  if (!rows.length) { el.innerHTML = `<p class="dash-empty">Unavailable.</p>`; return; }
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.ytd_pct || 0)));
  el.innerHTML = rows.map((r) => {
    const up = (r.ytd_pct || 0) >= 0, w = (Math.abs(r.ytd_pct || 0) / max) * 100;
    return `<div class="gm-flow-row"><span class="gm-flow-name">${_esc(r.label)}</span>
      <span class="gm-flow-track"><i class="gm-flow-bar ${up ? "up" : "down"}" style="width:${w}%"></i></span>
      <span class="gm-flow-val ${up ? "up" : "down"}">${_pctRaw(r.ytd_pct)}</span></div>`;
  }).join("");
}

// ---- world heatmap (Plotly choropleth, native per-country hover) ----
async function loadGmHeatmap() {
  const d = await _gmFetch("heatmap");
  _gmHmData = d.rows || [];
  const sub = document.getElementById("gm-hm-sub");
  if (sub) sub.textContent = d.source || "Economic momentum";
  _gmDrawHeatmap();
}
function _gmDrawHeatmap() {
  const el = document.getElementById("gm-heatmap");
  if (!el || typeof Plotly === "undefined" || !_gmHmData) return;
  const m = _gmHmMetric;
  const rows = _gmHmData.filter((r) => r[m] != null);
  const trace = {
    type: "choropleth", locationmode: "ISO-3",
    locations: rows.map((r) => r.iso3), z: rows.map((r) => r[m]),
    text: rows.map((r) => r.country),
    customdata: rows.map((r) => [r.growth != null ? r.growth : "—", r.inflation != null ? r.inflation : "—"]),
    hovertemplate: "<b>%{text}</b><br>Growth: %{customdata[0]}%<br>Inflation: %{customdata[1]}%<extra></extra>",
    colorscale: m === "growth"
      ? [[0, "#9e2b3a"], [0.5, "#caa53d"], [1, "#16a34a"]]
      : [[0, "#16a34a"], [0.5, "#caa53d"], [1, "#9e2b3a"]],
    zmid: m === "growth" ? 2 : 3,
    marker: { line: { color: "#0a1020", width: 0.4 } },
    colorbar: { thickness: 8, len: 0.7, x: 1, tickfont: { color: "#8b9bb5", size: 9 }, outlinewidth: 0, ticksuffix: "%" },
  };
  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)", margin: { l: 0, r: 0, t: 0, b: 0 },
    geo: { bgcolor: "rgba(0,0,0,0)", showframe: false, showcoastlines: false,
           landcolor: "#0e1626", showcountries: true, countrycolor: "#0a1020",
           projection: { type: "natural earth" }, lataxis: { range: [-56, 84] } },
    font: { color: "#9aa4b2" },
  };
  Plotly.react(el, [trace], layout, { displayModeBar: false, responsive: true });
}
document.getElementById("gm-hm-metric")?.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-m]"); if (!b) return;
  document.querySelectorAll("#gm-hm-metric button").forEach((x) => x.classList.toggle("active", x === b));
  _gmHmMetric = b.dataset.m;
  const sub = document.getElementById("gm-hm-sub");
  if (sub) sub.textContent = _gmHmMetric === "growth" ? "GDP growth (YoY, latest)" : "CPI inflation (YoY, latest)";
  _gmDrawHeatmap();
});
document.getElementById("gm-refresh")?.addEventListener("click", loadGlobalMarkets);

function _startGmClock() {
  if (_gmClockTimer) return;
  const tick = () => {
    const el = document.getElementById("gm-clock"); if (!el) return;
    el.textContent = new Date().toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })
      + " · " + new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };
  tick(); _gmClockTimer = setInterval(tick, 30000);
}

// --- Market news -----------------------------------------------------------
function _relTime(epoch) {
  if (!epoch) return "";
  const s = Math.max(0, Date.now() / 1000 - epoch);
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
let _newsAll = [], _newsSymbol = "", _newsCat = "all";
let _idxRange = "1d", _secRange = "1d", _moverKind = "gainers", _moversData = null;

// ---- category classification (drives the tab filter on the live tape) ----
const _CAT_KW = {
  macro: ["inflation", "cpi", "gdp", "jobs", "payroll", "unemployment", "economy",
          "treasury", "yield", "dollar", "recession", "consumer", "retail sales"],
  earnings: ["earnings", "eps", "revenue", "guidance", "beats", "misses", "quarter",
             "profit", "results", "forecast"],
  commodities: ["oil", "crude", "gold", "silver", "copper", "gas", "wti", "brent",
                "commodit", "opec", "metals", "wheat"],
  crypto: ["bitcoin", "btc", "ethereum", "eth", "crypto", "coinbase", "binance",
           "blockchain", "token", "stablecoin"],
  central: ["fed", "fomc", "powell", "ecb", "boj", "central bank", "rate cut",
            "rate hike", "interest rate", "monetary"],
};
function _newsCats(n) {
  const t = `${n.title || ""} ${n.summary || ""}`.toLowerCase();
  const cats = [];
  for (const [cat, kws] of Object.entries(_CAT_KW)) {
    if (kws.some((k) => t.includes(k))) cats.push(cat);
  }
  if ((n.tickers || []).length) cats.push("equities");
  return cats;
}

// Fetch the aggregated feed (macro, or stock-specific when a symbol is given).
async function fetchNews(symbol) {
  _newsSymbol = (symbol || "").trim().toUpperCase();
  const list = document.getElementById("nx-list");
  list.innerHTML = `<p class="dash-empty">Loading news…</p>`;
  try {
    const url = `/api/market-news?limit=60${_newsSymbol ? `&symbol=${encodeURIComponent(_newsSymbol)}` : ""}`;
    _newsAll = (await (await fetch(url)).json()).news || [];
  } catch {
    _newsAll = []; list.innerHTML = `<p class="dash-empty">Could not load news.</p>`; return;
  }
  renderBreaking();
  renderTape();
}

// Nav entry point — load the whole terminal once.
function loadNews() {
  fetchNews(_newsSymbol);
  loadIndices(_idxRange);
  loadMovers();
  loadSectors(_secRange);
  _startNewsClock();
}

function _newsScope() {
  const scope = document.getElementById("nx-scope");
  if (!scope) return;
  scope.innerHTML = _newsSymbol
    ? `· <b>${_esc(_newsSymbol)}</b> <a id="nx-clear">✕ macro</a>`
    : "";
}

const _IMPACT_LABEL = { high: "HIGH", medium: "MEDIUM", low: "LOW" };

function renderTape() {
  const list = document.getElementById("nx-list");
  _newsScope();
  let items = _newsAll.slice();
  if (_newsCat !== "all") items = items.filter((n) => _newsCats(n).includes(_newsCat));
  if (!items.length) { list.innerHTML = `<p class="dash-empty">No ${_newsCat === "all" ? "" : _newsCat + " "}news right now.</p>`; return; }
  list.innerHTML = items.map((n) => {
    const imp = (n.impact || "low");
    const syms = (n.tickers || []).slice(0, 3).map((t) => `<span class="nx-tk">${_esc(t)}</span>`).join("") || `<span class="nx-tk dim">—</span>`;
    return `<a class="nx-trow" href="${n.link || "#"}" ${n.link ? 'target="_blank" rel="noopener"' : ""}>
      <span class="nx-time">${_clockTime(n.published)}</span>
      <span class="nx-impact ${imp}">${_IMPACT_LABEL[imp] || "LOW"}</span>
      <span class="nx-src">${_esc(n.source)}</span>
      <span class="nx-syms">${syms}</span>
      <span class="nx-head">${_esc(n.title)}</span>
    </a>`;
  }).join("");
}

function renderBreaking() {
  const el = document.getElementById("nx-breaking");
  if (!el) return;
  const n = _newsAll[0];
  if (!n) { el.innerHTML = `<p class="dash-empty">No headlines.</p>`; return; }
  el.innerHTML = `<a class="nx-brk" href="${n.link || "#"}" ${n.link ? 'target="_blank" rel="noopener"' : ""}>
    ${n.thumbnail
      ? `<img class="nx-brk-img${n.contain ? " logo" : ""}" src="${_esc(n.thumbnail)}" loading="lazy" alt="" onerror="this.style.display='none'" />`
      : ""}
    <div class="nx-brk-body">
      <div class="nx-brk-title">${_esc(n.title)}</div>
      ${n.summary ? `<div class="nx-brk-sum">${_esc(n.summary)}</div>` : ""}
      <div class="nx-brk-meta"><span class="nx-src">${_esc(n.source)}</span><span>${_relTime(n.published)}</span></div>
    </div>
  </a>`;
}

// ---- category tabs ----
document.getElementById("nx-cats").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cat]"); if (!b) return;
  document.querySelectorAll("#nx-cats button").forEach((x) => x.classList.toggle("active", x === b));
  _newsCat = b.dataset.cat;
  renderTape();
});

// ---- market indices (Plotly multi-line) ----
async function loadIndices(range) {
  _idxRange = range || _idxRange;
  const legend = document.getElementById("nx-idx-legend");
  try {
    const d = await (await fetch(`/api/indices?range=${encodeURIComponent(_idxRange)}`)).json();
    const series = (d.series || []).map((s, i) => ({
      name: s.label,
      x: s.points.map((p) => new Date(p.t * 1000)),
      y: s.points.map((p) => p.v),
      color: PLOT_COLORS[i % PLOT_COLORS.length],
    }));
    plotLines("nx-indices", series, { ysuffix: "%", left: 44 });
    legend.innerHTML = (d.series || []).map((s, i) => `
      <div class="nx-leg"><span class="dot" style="background:${PLOT_COLORS[i % PLOT_COLORS.length]}"></span>
        <span class="lbl">${_esc(s.label)}</span>
        <span class="${s.change_pct >= 0 ? "up" : "down"}">${s.last.toLocaleString()} ${s.change_pct >= 0 ? "+" : ""}${s.change_pct.toFixed(2)}%</span></div>`).join("");
  } catch {
    legend.innerHTML = `<span class="dash-empty">Indices unavailable.</span>`;
  }
}
document.getElementById("nx-idx-range").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-r]"); if (!b) return;
  document.querySelectorAll("#nx-idx-range button").forEach((x) => x.classList.toggle("active", x === b));
  loadIndices(b.dataset.r);
});

// ---- top movers ----
async function loadMovers() {
  const el = document.getElementById("nx-movers");
  try {
    _moversData = await (await fetch("/api/movers")).json();
  } catch { el.innerHTML = `<p class="dash-empty">Movers unavailable.</p>`; return; }
  renderMovers();
}
function renderMovers() {
  const el = document.getElementById("nx-movers");
  const rows = (_moversData && _moversData[_moverKind]) || [];
  if (!rows.length) { el.innerHTML = `<p class="dash-empty">No data.</p>`; return; }
  el.innerHTML = `<div class="nx-mv-head"><span>SYMBOL</span><span>PRICE</span><span>% CHG</span></div>` +
    rows.map((r) => `<div class="nx-mv-row" data-sym="${_esc(r.symbol)}">
      <span class="nx-mv-sym ${r.change_pct >= 0 ? "up" : "down"}">${_esc(r.symbol)}</span>
      <span class="nx-mv-px">${r.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      <span class="nx-mv-chg ${r.change_pct >= 0 ? "up" : "down"}">${r.change_pct >= 0 ? "+" : ""}${r.change_pct.toFixed(2)}%</span>
    </div>`).join("");
}
document.getElementById("nx-mv-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mv]"); if (!b) return;
  document.querySelectorAll("#nx-mv-tabs button").forEach((x) => x.classList.toggle("active", x === b));
  _moverKind = b.dataset.mv;
  renderMovers();
});
document.getElementById("nx-movers").addEventListener("click", (e) => {
  const row = e.target.closest(".nx-mv-row[data-sym]"); if (!row) return;
  selectTicker(row.dataset.sym);
  _gotoPage("dashboard");          // jump to the dashboard for that symbol
});

// Programmatic page switch (mirrors a sidebar click) so deep-links from one
// page into another keep the nav highlight + lazy-loaders in sync.
function _gotoPage(page) {
  const btn = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (btn) btn.click();
}

// ---- sector performance ----
async function loadSectors(range) {
  _secRange = range || _secRange;
  const el = document.getElementById("nx-sectors");
  let rows = [];
  try {
    rows = (await (await fetch(`/api/sectors?range=${encodeURIComponent(_secRange)}`)).json()).rows || [];
  } catch { el.innerHTML = `<p class="dash-empty">Sectors unavailable.</p>`; return; }
  if (!rows.length) { el.innerHTML = `<p class="dash-empty">No data.</p>`; return; }
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.change_pct)));
  el.innerHTML = `<div class="nx-sec-head"><span>SECTOR</span><span>% CHANGE</span></div>` +
    rows.map((r) => {
      const w = (Math.abs(r.change_pct) / max) * 100;
      const up = r.change_pct >= 0;
      return `<div class="nx-sec-row">
        <span class="nx-sec-name">${_esc(r.sector)}</span>
        <span class="nx-sec-track"><i class="nx-sec-bar ${up ? "up" : "down"}" style="width:${w}%"></i></span>
        <span class="nx-sec-val ${up ? "up" : "down"}">${up ? "+" : ""}${r.change_pct.toFixed(2)}%</span>
      </div>`;
    }).join("");
}
document.getElementById("nx-sec-range").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-r]"); if (!b) return;
  document.querySelectorAll("#nx-sec-range button").forEach((x) => x.classList.toggle("active", x === b));
  loadSectors(b.dataset.r);
});

// ---- live clock (US Eastern, like a markets terminal) ----
let _newsClockTimer = null;
function _startNewsClock() {
  if (_newsClockTimer) return;
  const tick = () => {
    const el = document.getElementById("nx-clock");
    if (!el) return;
    const s = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZone: "America/New_York", hour12: true });
    el.textContent = `${s} EST`;
  };
  tick();
  _newsClockTimer = setInterval(tick, 1000);
}
// HH:MM clock-time for a unix ts (used in the tape's TIME column).
function _clockTime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/New_York", hour12: false });
}

// News symbol-search autosuggest — reuses the global localRank() + /api/search,
// same as the main search box and the smart-money filter.
const nxInputEl = document.getElementById("nx-symbol");
const nxSugEl   = document.getElementById("nx-sug");
let nxSugItems = [], nxSugActive = -1, nxLastQuery = "";

async function _nxRunSearch(q) {
  nxLastQuery = q;
  nxSugItems = localRank(q);
  _renderNxSug();
  try {
    const remote = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
    if (q !== nxLastQuery) return;
    nxSugItems = _mergeItems(nxSugItems, remote);
    _renderNxSug();
  } catch { /* keep local results */ }
}
function _renderNxSug() {
  nxSugEl.innerHTML = ""; nxSugActive = -1;
  if (!nxSugItems.length) { _hideNxSug(); return; }
  const q = nxInputEl.value.trim();
  nxSugItems.forEach((it, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span><span class="sym">${_mark(it.symbol, q)}</span> ${_mark(it.name || "", q)}</span>`
                 + `<span class="exch">${_esc(it.exchange || "")} ${_esc(it.type || "")}</span>`;
    li.addEventListener("mouseenter", () => { nxSugActive = i; _hlNx(); });
    li.addEventListener("click", () => _pickNx(it));
    nxSugEl.appendChild(li);
  });
  nxSugEl.classList.add("show");
}
function _hlNx() { [...nxSugEl.children].forEach((li, i) => li.classList.toggle("active", i === nxSugActive)); }
function _moveNxActive(d) { nxSugActive = (nxSugActive + d + nxSugItems.length) % nxSugItems.length; _hlNx(); }
function _hideNxSug() { nxSugEl.classList.remove("show"); nxSugItems = []; nxSugActive = -1; }
function _pickNx(it) { nxInputEl.value = it.symbol; _hideNxSug(); fetchNews(it.symbol); }

nxInputEl.addEventListener("input", () => {
  const q = nxInputEl.value.trim();
  if (!q) { _hideNxSug(); return; }
  _nxRunSearch(q);
});
nxInputEl.addEventListener("keydown", (e) => {
  if (!nxSugEl.classList.contains("show")) return;
  if (e.key === "ArrowDown")      { e.preventDefault(); _moveNxActive(1); }
  else if (e.key === "ArrowUp")   { e.preventDefault(); _moveNxActive(-1); }
  else if (e.key === "Enter" && nxSugActive >= 0) { e.preventDefault(); _pickNx(nxSugItems[nxSugActive]); }
  else if (e.key === "Escape")    _hideNxSug();
});
document.addEventListener("click", (e) => {
  if (!nxInputEl.contains(e.target) && !nxSugEl.contains(e.target)) _hideNxSug();
});

document.getElementById("nx-symform").addEventListener("submit", (e) => {
  e.preventDefault();
  _hideNxSug();
  const sym = nxInputEl.value.trim().split(/\s|—/)[0].trim().toUpperCase();
  fetchNews(sym);
});
document.getElementById("nx-refresh").addEventListener("click", () => fetchNews(_newsSymbol));
document.getElementById("nx-scope").addEventListener("click", (e) => {
  if (e.target.id === "nx-clear") { document.getElementById("nx-symbol").value = ""; fetchNews(""); }
});

// --------------------------------------------------------------------------- //
// Smart-money tracker (insiders / congress / institutional)
// --------------------------------------------------------------------------- //
let _smLoaded = false, _whaleLoaded = false;

function _sideTag(side) {
  const cls = side === "buy" ? "buy" : side === "sell" ? "sell" : "hold";
  const label = side === "buy" ? "BUY" : side === "sell" ? "SELL" : (side || "—").toUpperCase();
  return `<span class="sm-tag ${cls}">${label}</span>`;
}
function _fmtNum(v) {
  const n = Number(v);
  if (!isFinite(n) || v === "" || v == null) return v || "—";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(v);
}

function _renderCongress(cards) {
  if (!cards.length) return `<p class="dash-empty">No disclosed congressional trades.</p>`;
  return cards.map((c) => `
    <div class="sm-item">
      <div class="sm-row">
        <span class="sm-chamber ${c.chamber === "Senate" ? "senate" : "house"}">${_esc(c.chamber)}</span>
        <span class="sm-name">${_esc(c.name)}</span>${_sideTag(c.side)}
      </div>
      <div class="sm-sub">${_esc(c.symbol || c.asset || "")} · ${_esc(c.amount || "amount n/a")}</div>
      <div class="sm-sub dim">traded ${_esc(c.date || "?")}${c.disclosed ? ` · disclosed ${_esc(c.disclosed)}` : ""}</div>
    </div>`).join("");
}
function _renderInsider(cards) {
  if (!cards.length) return `<p class="dash-empty">No insider transactions.</p>`;
  return cards.map((c) => `
    <div class="sm-item">
      <div class="sm-row"><span class="sm-name">${_esc(c.name)}</span>${_sideTag(c.side)}</div>
      <div class="sm-sub">${_esc(c.symbol || "")}${c.role ? ` · ${_esc(c.role)}` : ""}</div>
      <div class="sm-sub dim">${_fmtNum(c.shares)} sh${c.price ? ` @ $${_esc(String(c.price).replace(/^\$+/, ""))}` : ""} · traded ${_esc(c.date || "?")}${c.disclosed ? ` · disclosed ${_esc(c.disclosed)}` : ""}</div>
    </div>`).join("");
}
// Tally most-traded tickers from the on-screen trades (client-side fallback so
// the leaderboard shows even if the backend didn't supply `most_traded`).
function _computeMostTraded(cards, top = 14) {
  const m = {};
  for (const c of cards || []) {
    const s = (c.symbol || "").toUpperCase();
    if (!s) continue;
    const d = m[s] || (m[s] = { symbol: s, count: 0, buys: 0, sells: 0 });
    d.count++;
    if (c.side === "buy") d.buys++; else if (c.side === "sell") d.sells++;
  }
  return Object.values(m).sort((a, b) => b.count - a.count).slice(0, top);
}
// Most-traded tickers leaderboard (à la congress.kadoa.com), pinned at the bottom.
function _renderMostTraded(rows) {
  if (!rows || !rows.length) return "";
  const max = rows[0].count || 1;
  return `<div class="sm-most-head"><i data-lucide="flame"></i><h3>Most traded by Congress (recent)</h3></div>
    <div class="sm-most-grid">` + rows.map((r) => `
      <button class="sm-most-item" data-sym="${_esc(r.symbol)}" title="Filter to ${_esc(r.symbol)}">
        <span class="smm-sym">${_esc(r.symbol)}</span>
        <span class="smm-bar"><span style="width:${Math.round((r.count / max) * 100)}%"></span></span>
        <span class="smm-ct">${r.count}<span class="smm-bs"> · ${r.buys}B/${r.sells}S</span></span>
      </button>`).join("") + `</div>`;
}
// --- Buy/sell flow histogram (shown when filtering to a specific ticker) ----
let _smData = null, _smTicker = "", _smFlowMonths = 6;

function _parseMoney(s) {  // "$1,234,567" / "1.2M" / "$1,001 - $15,000" → number ($)
  if (!s) return 0;
  const matches = String(s).replace(/,/g, "").match(/\d+(?:\.\d+)?\s*[kmb]?/gi);
  if (!matches) return 0;
  const vals = matches.map((m) => {
    m = m.trim().toLowerCase();
    let mul = 1;
    if (m.endsWith("b")) { mul = 1e9; m = m.slice(0, -1); }
    else if (m.endsWith("m")) { mul = 1e6; m = m.slice(0, -1); }
    else if (m.endsWith("k")) { mul = 1e3; m = m.slice(0, -1); }
    return parseFloat(m) * mul;
  }).filter((v) => isFinite(v));
  if (!vals.length) return 0;
  return vals.length > 1 ? vals.reduce((a, b) => a + b, 0) / vals.length : vals[0];  // range → midpoint
}
function _fmtUsd(n) {
  if (!n) return "$0";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + Math.round(n);
}
function _flowBuckets(items, months) {
  const now = new Date();
  const cutoff = months ? new Date(now.getFullYear(), now.getMonth() - months + 1, 1) : null;
  const map = {};
  for (const it of items) {
    const ym = (it.date || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    if (cutoff && new Date(ym + "-01") < cutoff) continue;
    const amt = _parseMoney(it.value || it.amount || "");
    const b = map[ym] || (map[ym] = { month: ym, buy: 0, sell: 0, buyN: 0, sellN: 0 });
    if (it.side === "buy") { b.buy += amt; b.buyN += 1; }
    else if (it.side === "sell") { b.sell += amt; b.sellN += 1; }
  }
  return Object.values(map).sort((a, b) => (a.month < b.month ? -1 : 1));
}
function _renderFlow() {
  const wrap = document.getElementById("sm-flow");
  if (!wrap) return;
  if (!_smTicker || !_smData) { wrap.hidden = true; return; }
  const items = [...(_smData.insider || []), ...(_smData.congress || [])];
  const buckets = _flowBuckets(items, _smFlowMonths);
  if (!buckets.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const useNot = buckets.reduce((s, b) => s + b.buy + b.sell, 0) > 0;  // $ if parseable, else counts
  const series = buckets.map((b) => ({ m: b.month, buy: useNot ? b.buy : b.buyN, sell: useNot ? b.sell : b.sellN }));
  const max = Math.max(1, ...series.map((s) => Math.max(s.buy, s.sell)));
  const fmt = useNot ? _fmtUsd : (n) => String(n);
  document.getElementById("sm-flow-unit").textContent =
    useNot ? "$ traded per month (insiders + Congress)" : "trade count per month (insiders + Congress)";

  // Two area-lines (green buys / red sells) drawn as SVG over the months. The
  // viewBox is sized to the data so a 1-3 point series doesn't stretch wide.
  const n = series.length;
  const W = Math.max(300, Math.min(900, n * 150)), H = 150, P = 12, yB = H - P;
  const X = (i) => (n === 1 ? W / 2 : P + (i / (n - 1)) * (W - 2 * P));
  const Y = (v) => yB - (v / max) * (H - 2 * P);
  const poly = (key) => series.map((s, i) => `${X(i).toFixed(1)},${Y(s[key]).toFixed(1)}`).join(" ");
  const area = (key) => `${X(0).toFixed(1)},${yB} ${poly(key)} ${X(n - 1).toFixed(1)},${yB}`;
  const dots = (key) => series.map((s, i) =>
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(s[key]).toFixed(1)}" r="2.5" class="smf-dot ${key}"><title>${s.m} · ${key === "buy" ? "Buys" : "Sells"} ${fmt(s[key])}</title></circle>`).join("");
  const yTicks = [max, max / 2, 0].map((v) => `<span>${fmt(v)}</span>`).join("");

  document.getElementById("sm-flow-chart").innerHTML =
    `<div class="smf-plot">
       <div class="smf-yaxis">${yTicks}</div>
       <div class="smf-main">
         <svg class="smf-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
           <polygon class="smf-area sell" points="${area("sell")}" />
           <polygon class="smf-area buy" points="${area("buy")}" />
           <polyline class="smf-line sell" points="${poly("sell")}" />
           <polyline class="smf-line buy" points="${poly("buy")}" />
           ${dots("sell")}${dots("buy")}
         </svg>
         <div class="smf-xlabels">${series.map((s) => `<span>${s.m.slice(2)}</span>`).join("")}</div>
       </div>
     </div>`;
}
// =========================================================================== //
// WHALE TRADING — tabbed tracker (ported from the open-source Whale-Watcher)
// =========================================================================== //
let _whaleTab = "dashboard";
let _whaleTimer = null;   // heatmap live-refresh interval
let _whaleGen = 0;        // bumps on every tab switch; stale async renders bail
function _whaleStale(gen) { return gen !== _whaleGen; }

function initWhale() {
  document.getElementById("whale-tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".wt-tab"); if (!b) return;
    whaleTab(b.dataset.wt);
  });
  // Click a heatmap cell → open that ticker on the Dashboard (same path as the
  // movers list). Delegated on #whale-body so it survives every tab re-render.
  document.getElementById("whale-body").addEventListener("click", (e) => {
    const cell = e.target.closest(".wt-cell[data-tk]"); if (!cell) return;
    selectTicker(cell.dataset.tk);
    _gotoPage("dashboard");
  });
  whaleTab("congress");
}
function whaleTab(name) {
  _whaleTab = name;
  const gen = ++_whaleGen;   // any in-flight render from a prior tab is now stale
  if (_whaleTimer) { clearInterval(_whaleTimer); _whaleTimer = null; }   // stop heatmap polling on tab switch
  document.querySelectorAll("#whale-tabs .wt-tab").forEach((b) => b.classList.toggle("active", b.dataset.wt === name));
  const body = document.getElementById("whale-body");
  body.innerHTML = `<p class="dash-empty">${_i18nTr("Loading…", window.__i18nLang || "English")}</p>`;
  const fn = WHALE_RENDER[name];
  Promise.resolve(fn ? fn(body, gen) : _whaleSoon(body))
    .catch((err) => { if (!_whaleStale(gen)) { console.error("whale tab failed:", err); body.innerHTML = `<p class="dash-empty">Could not load.</p>`; } })
    .finally(() => { if (!_whaleStale(gen) && window.lucide) lucide.createIcons(); });
}
async function _whaleGet(path) { return (await fetch(path)).json(); }
function _whaleSoon(body) {
  body.innerHTML = `<div class="wt-soon"><i data-lucide="construction"></i>
    <p>This tab needs a data provider key (or heavy live polling) — coming soon.</p></div>`;
}
// formatting helpers
function _wUsd(n) { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n);
  if (a >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T"; if (a >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M"; if (a >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K"; return "$" + Math.round(n); }
function _wNum(n) { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + "B"; if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(0) + "K"; return String(Math.round(n)); }
function _wPct(n, d = 1) { return (n == null || !isFinite(n)) ? "—" : (n >= 0 ? "+" : "") + Number(n).toFixed(d) + "%"; }
function _partyCls(p) { return p === "D" ? "dem" : p === "R" ? "rep" : "ind"; }

const WHALE_RENDER = {
  congress: renderWhaleCongress, members: renderWhaleMembers,
  insiders: renderWhaleInsiders, options: renderWhaleOptions, darkpool: renderWhaleDarkpool,
  investors: renderWhaleInvestors,
  heatmap: renderWhaleHeatmap,
};

function _isBuy(t) { return (t.type || "").toLowerCase().startsWith("purchase") || (t.type || "").toLowerCase() === "buy"; }
function _congressAggregate(trades) {
  let buys = 0, sells = 0, dem = 0, rep = 0;
  const byTicker = {};
  for (const t of trades) {
    if (_isBuy(t)) buys++; else sells++;
    const p = (t.party || "").toUpperCase();
    if (p.startsWith("D")) dem++; else if (p.startsWith("R")) rep++;
    const k = t.ticker; if (!k || k === "--") continue;
    const a = byTicker[k] || (byTicker[k] = { ticker: k, buys: 0, sells: 0, n: 0, vol: 0 });
    a.n++; a.vol += _parseMoney(t.amount); if (_isBuy(t)) a.buys++; else a.sells++;
  }
  const top = Object.values(byTicker).sort((a, b) => b.n - a.n).slice(0, 8);
  const maxN = Math.max(1, ...top.map((t) => t.n));
  const tot = buys + sells || 1;
  const bars = top.map((t) => {
    const bw = Math.round(t.buys / Math.max(1, t.n) * 100);
    return `<div class="wt-agg-row" data-tk="${_esc(t.ticker)}" title="Click to view ${_esc(t.ticker)} on the dashboard">
      <span class="wt-agg-tk">${_esc(t.ticker)}</span>
      <span class="wt-agg-track"><span class="wt-agg-fill" style="width:${Math.round(t.n / maxN * 100)}%"><span class="wt-agg-buy" style="width:${bw}%"></span></span></span>
      <span class="wt-agg-n">${t.n}× · ${_wUsd(t.vol)}</span></div>`;
  }).join("");
  const pct = (x) => Math.round(x / tot * 100);
  return `<div class="wt-agg">
    <div class="wt-agg-cards">
      <div class="wt-ostat"><span class="wt-ostat-l">DISCLOSED TRADES</span><span class="wt-ostat-v">${trades.length}</span></div>
      <div class="wt-ostat"><span class="wt-ostat-l">BUY / SELL</span><span class="wt-ostat-v"><span class="up">${buys}</span> / <span class="down">${sells}</span></span><span class="wt-ostat-s ${buys >= sells ? "up" : "down"}">${buys >= sells ? "net buying" : "net selling"} · ${pct(Math.max(buys, sells))}%</span></div>
      <div class="wt-ostat"><span class="wt-ostat-l">PARTY SPLIT</span><span class="wt-ostat-v"><span class="wt-party dem">D</span> ${dem} · <span class="wt-party rep">R</span> ${rep}</span></div>
      <div class="wt-ostat"><span class="wt-ostat-l">TICKERS</span><span class="wt-ostat-v">${Object.keys(byTicker).length}</span><span class="wt-ostat-s">distinct names</span></div>
    </div>
    <div class="wt-agg-bars"><div class="wt-agg-h">Most-traded tickers <span class="dim">(bar = trade count · green = buy share)</span></div>${bars}</div>
  </div>`;
}
async function renderWhaleCongress(body, gen) {
  const d = await _whaleGet("/api/whale/congress");
  if (_whaleStale(gen)) return;
  const trades = (d.trades || []).slice().sort((a, b) =>
    ((b.transactionDate || "") > (a.transactionDate || "") ? 1 : (b.transactionDate || "") < (a.transactionDate || "") ? -1 : 0));
  if (!trades.length) { body.innerHTML = `<p class="dash-empty">No congressional trades.</p>`; return; }
  const src = d.source === "live" ? `<span class="wt-src dim">● live · ${_esc(d.provider)}</span>`
    : d.source === "stale" ? `<span class="wt-src dim">last good snapshot</span>`
    : `<span class="wt-src dim">cached fallback</span>`;
  const rows = trades.map((t) => `<tr>
    <td><span class="wt-party ${_partyCls(t.party)}">${_esc(t.party)}</span> ${_esc(t.representative)}</td>
    <td class="dim">${_esc(t.chamber === "Senate" ? "Senate" : "House")}</td>
    <td><b>${_esc(t.ticker)}</b></td>
    <td>${_sideTag(_isBuy(t) ? "buy" : "sell")}</td>
    <td>${_esc(t.amount)}</td>
    <td class="dim">${_esc((t.transactionDate || "").slice(0, 10))}</td>
    <td class="${(t.excessReturn || 0) >= 0 ? "up" : "down"}">${t.excessReturn != null ? _wPct(t.excessReturn) : "—"}</td></tr>`).join("");
  body.innerHTML = `<div class="wt-tabletop">${src}<span class="dim">sorted by transaction date</span></div>
    ${_congressAggregate(trades)}
    <div class="wt-tablewrap"><table class="wt-table"><thead><tr><th>Member</th><th>Chamber</th><th>Ticker</th><th>Type</th><th>Amount</th><th>Date</th><th>vs SPY</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
  const agg = body.querySelector(".wt-agg-bars");
  if (agg) agg.addEventListener("click", (e) => {
    const r = e.target.closest(".wt-agg-row[data-tk]"); if (!r) return;
    selectTicker(r.dataset.tk); _gotoPage("dashboard");
  });
}

let _whaleMemberData = null;
async function renderWhaleMembers(body, gen) {
  const d = await _whaleGet("/api/whale/congress");
  if (_whaleStale(gen)) return;
  const trades = d.trades || [];
  const map = {};
  for (const t of trades) {
    const m = map[t.representative] || (map[t.representative] = { name: t.representative, party: t.party, state: t.state, chamber: t.chamber, buys: 0, sells: 0, vol: 0, tickers: {}, alpha: [], trades: [] });
    if (_isBuy(t)) m.buys++; else m.sells++;
    m.vol += _parseMoney(t.amount);
    if (t.ticker && t.ticker !== "--") m.tickers[t.ticker] = (m.tickers[t.ticker] || 0) + 1;
    if (t.excessReturn != null) m.alpha.push(t.excessReturn);
    m.trades.push(t);
  }
  _whaleMemberData = Object.values(map).map((m) => {
    m.total = m.buys + m.sells;
    m.top = Object.entries(m.tickers).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    m.avgAlpha = m.alpha.length ? m.alpha.reduce((a, b) => a + b, 0) / m.alpha.length : null;
    return m;
  }).sort((a, b) => b.vol - a.vol);
  _renderMembersGrid(body);
}
function _renderMembersGrid(body) {
  const members = _whaleMemberData || [];
  if (!members.length) { body.innerHTML = `<p class="dash-empty">No member data.</p>`; return; }
  const cards = members.map((m) => `<div class="wt-member" data-mem="${_esc(m.name)}" title="View ${_esc(m.name)}'s trading">
    <div class="wt-member-top"><span class="wt-party ${_partyCls(m.party)}">${_esc(m.party)}</span>
      <span class="wt-member-name">${_esc(m.name)}</span>${_chamberBadge(m.chamber)}${m.state && m.state !== "??" ? `<span class="dim">${_esc(m.state)}</span>` : ""}
      <span class="wt-member-sent ${m.buys >= m.sells ? "up" : "down"}">${m.buys >= m.sells ? "bullish" : "bearish"}</span></div>
    <div class="wt-member-stats">
      <span class="up">${m.buys} buys</span><span class="down">${m.sells} sells</span>
      <span>${_wUsd(m.vol)} vol</span>${m.top ? `<span class="dim">top: ${_esc(m.top)}</span>` : ""}
      ${m.avgAlpha != null ? `<span class="${m.avgAlpha >= 0 ? "up" : "down"}">${_wPct(m.avgAlpha)} vs SPY</span>` : ""}
    </div></div>`).join("");
  body.innerHTML = `<div class="wt-members">${cards}</div>`;
  body.querySelector(".wt-members").addEventListener("click", (e) => {
    const card = e.target.closest(".wt-member[data-mem]"); if (!card) return;
    _renderMemberDetail(card.dataset.mem);
  });
}
function _chamberBadge(chamber) {
  if (!chamber) return "";
  const sen = /senate/i.test(chamber);   // note: "repreSENtatives" contains "sen" — match the full word
  return `<span class="wt-chamber ${sen ? "senate" : "house"}">${sen ? "Senate" : "House"}</span>`;
}
function _memInitials(name) {
  return (name || "?").replace(/\b(dr|mr|mrs|ms|jr|sr|ii|iii)\b/gi, "").trim()
    .split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
}
async function _renderMemberDetail(name) {
  const m = (_whaleMemberData || []).find((x) => x.name === name); if (!m) return;
  const body = document.getElementById("whale-body");
  // "Holdings spread": disclosed trades aggregated by ticker (traded $ as a size
  // proxy — individual members of Congress don't file 13F portfolio holdings).
  const spread = {};
  for (const t of m.trades) { const k = t.ticker; if (!k || k === "--") continue; spread[k] = (spread[k] || 0) + _parseMoney(t.amount); }
  const total = Object.values(spread).reduce((s, v) => s + v, 0) || 1;
  const rows = Object.entries(spread).map(([ticker, value]) => ({ ticker, name: ticker, value, pct: Math.round(value / total * 1000) / 10 })).sort((a, b) => b.value - a.value);
  const tbl = m.trades.slice().sort((a, b) => ((a.transactionDate || "") < (b.transactionDate || "") ? 1 : -1))
    .map((t) => `<tr><td><b>${_esc(t.ticker)}</b></td><td>${_sideTag(t.type === "sale" ? "sell" : "buy")}</td><td>${_esc(t.amount)}</td><td class="dim">${_esc((t.transactionDate || "").slice(0, 10))}</td><td class="${(t.excessReturn || 0) >= 0 ? "up" : "down"}">${t.excessReturn != null ? _wPct(t.excessReturn) : "—"}</td></tr>`).join("");
  body.innerHTML = `<button class="wt-back" id="wt-mem-back">← All members</button>
    <div class="wt-inv-dethead"><span class="wt-inv-av big" id="wt-mem-photo">${_memInitials(m.name)}</span>
      <div class="wt-inv-id"><div class="wt-inv-name"><span class="wt-party ${_partyCls(m.party)}">${_esc(m.party)}</span> ${_esc(m.name)} ${_chamberBadge(m.chamber)}${m.state && m.state !== "??" ? ` <span class="dim">${_esc(m.state)}</span>` : ""}</div>
        <div class="dim">${m.buys} buys · ${m.sells} sells · ${_wUsd(m.vol)} traded${m.avgAlpha != null ? ` · <span class="${m.avgAlpha >= 0 ? "up" : "down"}">${_wPct(m.avgAlpha)} vs SPY</span>` : ""}</div></div></div>
    <p class="wt-inv-bio" id="wt-mem-bio">Loading profile…</p>
    ${rows.length ? _piHtml(rows, (r) => r.ticker) : ""}
    <div class="dim wt-note">Disclosed STOCK Act trades by traded value — a proxy for position size; members of Congress don't file 13F holdings.</div>
    <table class="wt-table sm"><thead><tr><th>Ticker</th><th>Type</th><th>Amount</th><th>Date</th><th>vs SPY</th></tr></thead><tbody>${tbl}</tbody></table>`;
  document.getElementById("wt-mem-back").addEventListener("click", () => _renderMembersGrid(document.getElementById("whale-body")));
  // Lazy-load the Wikipedia photo + bio for this member.
  try {
    const w = await (await fetch("/api/whale/wiki?context=politician&title=" + encodeURIComponent(m.name))).json();
    const bioEl = document.getElementById("wt-mem-bio");
    const photoEl = document.getElementById("wt-mem-photo");
    if (bioEl) bioEl.innerHTML = w.bio ? `${_esc(w.bio)}${w.wikiUrl ? ` <a href="${_esc(w.wikiUrl)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}` : "No Wikipedia profile found.";
    if (photoEl && w.photo) photoEl.outerHTML = `<img class="wt-inv-photo" src="${_esc(w.photo)}" alt="${_esc(m.name)}" loading="lazy" onerror="this.outerHTML='<span class=\\'wt-inv-av big\\'>${_memInitials(m.name)}</span>'">`;
  } catch { const b = document.getElementById("wt-mem-bio"); if (b) b.textContent = ""; }
}

// Insiders: senior corporate filers (C-suite + Directors + 10% owners), grouped
// per person into clickable cards mirroring the Members tab.
const _EXEC_ROLE = /chief|\bceo\b|\bcfo\b|\bcoo\b|\bcto\b|president|chair|officer|director|10%|owner|\bevp\b|\bsvp\b/i;
function _parseInsiderVal(v) { const n = parseFloat(String(v || "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? Math.abs(n) : 0; }
function _execTitle(role) {
  const r = (role || "").toLowerCase();
  if (/ceo|chief exec/.test(r)) return "CEO";
  if (/cfo|chief financ/.test(r)) return "CFO";
  if (/coo|chief oper/.test(r)) return "COO";
  if (/cto|chief tech/.test(r)) return "CTO";
  if (/chief/.test(r)) return role;
  if (/chair/.test(r)) return "Chair";
  if (/president/.test(r)) return "President";
  if (/10%|owner/.test(r)) return "10% Owner";
  if (/director/.test(r)) return "Director";
  return role || "Officer";
}
let _whaleInsiderData = null;
async function renderWhaleInsiders(body, gen) {
  const d = await _whaleGet("/api/smart-money");
  if (_whaleStale(gen)) return;
  const raw = (d.insider || []).filter((t) => _EXEC_ROLE.test(t.role || ""));
  const map = {};
  for (const t of raw) {
    const m = map[t.name] || (map[t.name] = { name: t.name, role: t.role, buys: 0, sells: 0, vol: 0, tickers: {}, companies: {}, trades: [] });
    if ((t.side || "").toLowerCase() === "buy") m.buys++; else m.sells++;
    m.vol += _parseInsiderVal(t.value);
    if (t.symbol) { m.tickers[t.symbol] = (m.tickers[t.symbol] || 0) + _parseInsiderVal(t.value); m.companies[t.symbol] = true; }
    m.trades.push(t);
  }
  _whaleInsiderData = Object.values(map).map((m) => {
    m.total = m.buys + m.sells;
    m.title = _execTitle(m.role);
    m.top = Object.entries(m.tickers).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return m;
  }).sort((a, b) => b.vol - a.vol);
  _renderInsiderGrid(body);
}
function _renderInsiderGrid(body) {
  const execs = _whaleInsiderData || [];
  if (!execs.length) { body.innerHTML = `<p class="dash-empty">No senior-insider (Form 4) activity right now.</p>`; return; }
  const cards = execs.map((m) => `<div class="wt-member" data-ins="${_esc(m.name)}" title="View ${_esc(m.name)}'s transactions">
    <div class="wt-member-top"><span class="wt-chamber house">${_esc(m.title)}</span>
      <span class="wt-member-name">${_esc(m.name)}</span>
      <span class="wt-member-sent ${m.buys >= m.sells ? "up" : "down"}">${m.buys >= m.sells ? "buying" : "selling"}</span></div>
    <div class="wt-member-stats">
      <span class="up">${m.buys} buys</span><span class="down">${m.sells} sells</span>
      <span>${_wUsd(m.vol)} traded</span>${m.top ? `<span class="dim">top: ${_esc(m.top)}</span>` : ""}
    </div></div>`).join("");
  body.innerHTML = `<div class="dim wt-note">Senior corporate insiders — C-suite, directors and 10% owners (SEC Form 4). Click a name for their transaction spread.</div><div class="wt-members">${cards}</div>`;
  body.querySelector(".wt-members").addEventListener("click", (e) => {
    const card = e.target.closest(".wt-member[data-ins]"); if (!card) return;
    _renderInsiderDetail(card.dataset.ins);
  });
}
async function _renderInsiderDetail(name) {
  const m = (_whaleInsiderData || []).find((x) => x.name === name); if (!m) return;
  const body = document.getElementById("whale-body");
  const total = Object.values(m.tickers).reduce((s, v) => s + v, 0) || 1;
  const rows = Object.entries(m.tickers).map(([ticker, value]) => ({ ticker, name: ticker, value, pct: Math.round(value / total * 1000) / 10 })).sort((a, b) => b.value - a.value);
  const tbl = m.trades.slice().sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1))
    .map((t) => `<tr><td><b>${_esc(t.symbol)}</b></td><td>${_sideTag((t.side || "").toLowerCase() === "buy" ? "buy" : "sell")}</td><td class="dim">${_esc(t.shares)}</td><td>${_esc(t.price)}</td><td class="${(t.side || "").toLowerCase() === "buy" ? "up" : "down"}">${_esc(t.value)}</td><td class="dim">${_esc((t.date || "").slice(0, 10))}</td></tr>`).join("");
  body.innerHTML = `<button class="wt-back" id="wt-ins-back">← All insiders</button>
    <div class="wt-inv-dethead"><span class="wt-inv-av big" id="wt-ins-photo">${_memInitials(m.name)}</span>
      <div class="wt-inv-id"><div class="wt-inv-name">${_esc(m.name)} <span class="wt-chamber house">${_esc(m.title)}</span></div>
        <div class="dim">${m.buys} buys · ${m.sells} sells · ${_wUsd(m.vol)} traded</div></div></div>
    <p class="wt-inv-bio" id="wt-ins-bio">Loading profile…</p>
    ${rows.length ? _piHtml(rows, (r) => r.ticker) : ""}
    <div class="dim wt-note">Form 4 transactions aggregated by company (traded value as a size proxy).</div>
    <table class="wt-table sm"><thead><tr><th>Ticker</th><th>Side</th><th>Shares</th><th>Price</th><th>Value</th><th>Date</th></tr></thead><tbody>${tbl}</tbody></table>`;
  document.getElementById("wt-ins-back").addEventListener("click", () => _renderInsiderGrid(document.getElementById("whale-body")));
  // Lazy-load a Wikipedia photo/bio (most executives won't have one — initials remain).
  try {
    const w = await (await fetch("/api/whale/wiki?title=" + encodeURIComponent(m.name))).json();
    const bioEl = document.getElementById("wt-ins-bio");
    const photoEl = document.getElementById("wt-ins-photo");
    if (bioEl) bioEl.innerHTML = w.bio ? `${_esc(w.bio)}${w.wikiUrl ? ` <a href="${_esc(w.wikiUrl)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}` : "No Wikipedia profile found.";
    if (photoEl && w.photo) photoEl.outerHTML = `<img class="wt-inv-photo" src="${_esc(w.photo)}" alt="${_esc(m.name)}" loading="lazy" onerror="this.outerHTML='<span class=\\'wt-inv-av big\\'>${_memInitials(m.name)}</span>'">`;
  } catch { const b = document.getElementById("wt-ins-bio"); if (b) b.textContent = ""; }
}

// Options ticker autosuggest (operates on the freshly-rendered #wt-opt-* nodes).
const _optSug = { items: [], active: -1, lastQ: "" };
async function _optRunSearch(q) {
  _optSug.lastQ = q;
  _optSug.items = localRank(q);
  _renderOptSug();
  try {
    const remote = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
    if (q !== _optSug.lastQ) return;
    _optSug.items = _mergeItems(_optSug.items, remote);
    _renderOptSug();
  } catch { /* keep local results */ }
}
function _renderOptSug() {
  const inp = document.getElementById("wt-opt-input"), sug = document.getElementById("wt-opt-sug");
  if (!sug || !inp) return;
  sug.innerHTML = ""; _optSug.active = -1;
  if (!_optSug.items.length) { sug.classList.remove("show"); return; }
  const q = inp.value.trim();
  _optSug.items.forEach((it, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span><span class="sym">${_mark(it.symbol, q)}</span> ${_mark(it.name || "", q)}</span>`
                 + `<span class="exch">${_esc(it.exchange || "")} ${_esc(it.type || "")}</span>`;
    li.addEventListener("mouseenter", () => { _optSug.active = i; _hlOpt(); });
    li.addEventListener("click", () => _pickOpt(it));
    sug.appendChild(li);
  });
  sug.classList.add("show");
}
function _hlOpt() { const sug = document.getElementById("wt-opt-sug"); if (sug) [...sug.children].forEach((li, i) => li.classList.toggle("active", i === _optSug.active)); }
function _moveOpt(d) { _optSug.active = (_optSug.active + d + _optSug.items.length) % _optSug.items.length; _hlOpt(); }
function _hideOptSug() { const sug = document.getElementById("wt-opt-sug"); if (sug) sug.classList.remove("show"); _optSug.items = []; _optSug.active = -1; }
function _pickOpt(it) { const inp = document.getElementById("wt-opt-input"); if (inp) inp.value = it.symbol; _hideOptSug(); _optLoad(it.symbol); }
document.addEventListener("click", (e) => {
  const inp = document.getElementById("wt-opt-input"), sug = document.getElementById("wt-opt-sug");
  if (sug && inp && !inp.contains(e.target) && !sug.contains(e.target)) _hideOptSug();
});

const _OPT_TICKERS = ["SPY", "QQQ", "IWM", "DIA", "NVDA", "AAPL", "TSLA", "MSFT", "META", "AMZN",
  "GOOGL", "AMD", "NFLX", "AVGO", "PLTR", "COIN", "MSTR", "SMCI", "BABA", "GME"];
let _optState = { ticker: "SPY", filter: "unusual", data: null };
async function renderWhaleOptions(body, gen) {
  body.innerHTML = `
    <div class="wt-opt-chips" id="wt-opt-chips">${_OPT_TICKERS.map((t) => `<button class="wt-octk${t === _optState.ticker ? " active" : ""}" data-tk="${t}">${t}</button>`).join("")}
      <form id="wt-opt-form" class="wt-opt-search" autocomplete="off"><input id="wt-opt-input" placeholder="Search ticker…" /><ul id="wt-opt-sug" class="suggestions"></ul></form></div>
    <div id="wt-opt-stats" class="wt-opt-stats"></div>
    <div class="wt-opt-filters" id="wt-opt-filters">
      <button data-f="unusual" class="active">⚡ Unusual Activity</button>
      <button data-f="all">All Flow</button>
      <button data-f="call">Calls Only</button>
      <button data-f="put">Puts Only</button></div>
    <div id="wt-opt-table"><p class="dash-empty">Loading…</p></div>`;
  document.getElementById("wt-opt-chips").addEventListener("click", (e) => {
    const b = e.target.closest(".wt-octk"); if (!b) return; _optLoad(b.dataset.tk);
  });
  // Ticker autosuggest (reuses the global search index + /api/search).
  const inp = document.getElementById("wt-opt-input");
  inp.addEventListener("input", () => { const q = inp.value.trim(); if (!q) { _hideOptSug(); return; } _optRunSearch(q); });
  inp.addEventListener("keydown", (e) => {
    const sug = document.getElementById("wt-opt-sug");
    if (!sug || !sug.classList.contains("show")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); _moveOpt(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _moveOpt(-1); }
    else if (e.key === "Enter" && _optSug.active >= 0) { e.preventDefault(); _pickOpt(_optSug.items[_optSug.active]); }
    else if (e.key === "Escape") _hideOptSug();
  });
  document.getElementById("wt-opt-form").addEventListener("submit", (e) => {
    e.preventDefault(); _hideOptSug();
    const v = inp.value.trim().split(/\s|—/)[0].trim().toUpperCase(); if (v) _optLoad(v);
  });
  document.getElementById("wt-opt-filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]"); if (!b) return;
    _optState.filter = b.dataset.f;
    document.querySelectorAll("#wt-opt-filters button").forEach((x) => x.classList.toggle("active", x === b));
    _optRenderTable();
  });
  await _optLoad(_optState.ticker);
}
async function _optLoad(ticker) {
  _optState.ticker = ticker;
  document.querySelectorAll("#wt-opt-chips .wt-octk").forEach((x) => x.classList.toggle("active", x.dataset.tk === ticker));
  const stats = document.getElementById("wt-opt-stats"); const table = document.getElementById("wt-opt-table");
  if (!stats) return;
  table.innerHTML = `<p class="dash-empty">Loading ${_esc(ticker)} options…</p>`;
  let d;
  try { d = await _whaleGet(`/api/whale/options?ticker=${encodeURIComponent(ticker)}`); }
  catch { table.innerHTML = `<p class="dash-empty">Could not load options.</p>`; return; }
  if (_optState.ticker !== ticker) return;   // superseded by a newer click
  _optState.data = d;
  const q = d.quote || {}; const pc = d.putCallRatio;
  const pcCls = pc == null ? "" : pc > 1.1 ? "down" : pc < 0.9 ? "up" : "";
  const pcLabel = pc == null ? "" : pc > 1.1 ? "BEARISH" : pc < 0.9 ? "BULLISH" : "NEUTRAL";
  const up = (q.changePct ?? 0) >= 0;
  stats.innerHTML = `
    <div class="wt-ostat"><span class="wt-ostat-l">PRICE</span><span class="wt-ostat-v">${q.price != null ? "$" + q.price : "—"}</span><span class="wt-ostat-s ${up ? "up" : "down"}">${q.changePct != null ? (up ? "▲ " : "▼ ") + Math.abs(q.changePct).toFixed(2) + "%" : ""}</span></div>
    <div class="wt-ostat"><span class="wt-ostat-l">PUT/CALL RATIO</span><span class="wt-ostat-v ${pcCls}">${pc != null ? pc : "—"}</span><span class="wt-ostat-s ${pcCls}">${pcLabel}</span></div>
    <div class="wt-ostat"><span class="wt-ostat-l">CALL VOLUME</span><span class="wt-ostat-v up">${_wNum(d.totalCallVol)}</span></div>
    <div class="wt-ostat"><span class="wt-ostat-l">PUT VOLUME</span><span class="wt-ostat-v down">${_wNum(d.totalPutVol)}</span></div>
    <div class="wt-ostat"><span class="wt-ostat-l">⚡ UNUSUAL</span><span class="wt-ostat-v" style="color:#f5a623">${d.unusual ?? 0}</span><span class="wt-ostat-s">exp ${_esc(d.expiry || "")}${d.dte != null ? ` · ${d.dte}d` : ""}</span></div>`;
  _optRenderTable();
}
function _optRenderTable() {
  const table = document.getElementById("wt-opt-table"); const d = _optState.data; if (!table || !d) return;
  let rows = d.flow || [];
  const f = _optState.filter;
  if (f === "unusual") rows = rows.filter((r) => r.unusual);
  else if (f === "call") rows = rows.filter((r) => r.type === "call");
  else if (f === "put") rows = rows.filter((r) => r.type === "put");
  if (!rows.length) { table.innerHTML = `<p class="dash-empty">No contracts match this filter.</p>`; return; }
  const body = rows.map((r) => `<tr>
    <td><span class="wt-otype ${r.type}">${r.type.toUpperCase()}</span>${r.unusual ? `<span class="wt-ounusual">⚡ UNUSUAL</span>` : ""}</td>
    <td><b>$${r.strike}</b> <span class="dim">${r.inTheMoney ? "ITM" : "OTM"}</span></td>
    <td>${_esc(r.expiry)} <span class="dim">${r.dte}d</span></td>
    <td>$${r.lastPrice}</td>
    <td class="${r.type === "call" ? "up" : "down"}">${_wUsd(r.premium)}</td>
    <td>${_wNum(r.volume)}</td><td class="dim">${_wNum(r.openInterest)}</td>
    <td class="${r.volOiRatio > 1 ? "wt-hot" : ""}">${r.volOiRatio}x</td>
    <td class="dim">${r.iv}%</td>
    <td class="${(r.delta || 0) >= 0 ? "up" : "down"}">${r.delta != null ? r.delta : "—"}</td>
    <td class="dim">${r.theta != null ? r.theta : "—"}</td></tr>`).join("");
  table.innerHTML = `<div class="wt-tablewrap"><table class="wt-table wt-opt-tbl"><thead><tr>
    <th>Type</th><th>Strike</th><th>Expiry</th><th>Price</th><th>Premium</th><th>Volume</th><th>Open Int</th><th>Vol/OI</th><th>IV</th><th>Δ Delta</th><th>θ Theta</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

// ── Dark Pool ticker autosuggest (reuses the global search index + /api/search) ──
const _dpSug = { items: [], active: -1, lastQ: "" };
async function _dpRunSearch(q) {
  _dpSug.lastQ = q;
  _dpSug.items = localRank(q);
  _renderDpSug();
  try {
    const remote = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
    if (q !== _dpSug.lastQ) return;
    _dpSug.items = _mergeItems(_dpSug.items, remote);
    _renderDpSug();
  } catch { /* keep local results */ }
}
function _renderDpSug() {
  const inp = document.getElementById("wt-dp-input"), sug = document.getElementById("wt-dp-sug");
  if (!sug || !inp) return;
  sug.innerHTML = ""; _dpSug.active = -1;
  if (!_dpSug.items.length) { sug.classList.remove("show"); return; }
  const q = inp.value.trim();
  _dpSug.items.forEach((it, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span><span class="sym">${_mark(it.symbol, q)}</span> ${_mark(it.name || "", q)}</span>`
                 + `<span class="exch">${_esc(it.exchange || "")} ${_esc(it.type || "")}</span>`;
    li.addEventListener("mouseenter", () => { _dpSug.active = i; _hlDp(); });
    li.addEventListener("click", () => _pickDp(it));
    sug.appendChild(li);
  });
  sug.classList.add("show");
}
function _hlDp() { const sug = document.getElementById("wt-dp-sug"); if (sug) [...sug.children].forEach((li, i) => li.classList.toggle("active", i === _dpSug.active)); }
function _moveDp(d) { _dpSug.active = (_dpSug.active + d + _dpSug.items.length) % _dpSug.items.length; _hlDp(); }
function _hideDpSug() { const sug = document.getElementById("wt-dp-sug"); if (sug) sug.classList.remove("show"); _dpSug.items = []; _dpSug.active = -1; }
function _pickDp(it) { const inp = document.getElementById("wt-dp-input"); if (inp) inp.value = it.symbol; _hideDpSug(); _dpLoad(it.symbol); }
document.addEventListener("click", (e) => {
  const inp = document.getElementById("wt-dp-input"), sug = document.getElementById("wt-dp-sug");
  if (sug && inp && !inp.contains(e.target) && !sug.contains(e.target)) _hideDpSug();
});

let _dpState = { ticker: "", filter: "all", data: null };
async function renderWhaleDarkpool(body) {
  body.innerHTML = `
    <div class="wt-opt-chips" id="wt-dp-chips">
      <button class="wt-octk${_dpState.ticker === "" ? " active" : ""}" data-dptk="">📊 Top 150 (market-wide)</button>
      <form id="wt-dp-form" class="wt-opt-search" autocomplete="off"><input id="wt-dp-input" placeholder="Search any ticker…" /><ul id="wt-dp-sug" class="suggestions"></ul></form></div>
    <div id="wt-dp-stats" class="wt-opt-stats"></div>
    <div class="wt-opt-filters" id="wt-dp-filters">
      <button data-f="all" class="active">All</button>
      <button data-f="bullish">🟢 Accumulation</button>
      <button data-f="bearish">🔴 Distribution</button>
      <button data-f="neutral">Neutral</button></div>
    <div id="wt-dp-list"><p class="dash-empty">Loading…</p></div>`;
  document.getElementById("wt-dp-chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-dptk]"); if (!b) return;
    const inp = document.getElementById("wt-dp-input"); if (inp) inp.value = "";
    _dpLoad(b.dataset.dptk);
  });
  const inp = document.getElementById("wt-dp-input");
  inp.addEventListener("input", () => { const q = inp.value.trim(); if (!q) { _hideDpSug(); return; } _dpRunSearch(q); });
  inp.addEventListener("keydown", (e) => {
    const sug = document.getElementById("wt-dp-sug");
    if (!sug || !sug.classList.contains("show")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); _moveDp(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _moveDp(-1); }
    else if (e.key === "Enter" && _dpSug.active >= 0) { e.preventDefault(); _pickDp(_dpSug.items[_dpSug.active]); }
    else if (e.key === "Escape") _hideDpSug();
  });
  document.getElementById("wt-dp-form").addEventListener("submit", (e) => {
    e.preventDefault(); _hideDpSug();
    const v = inp.value.trim().split(/\s|—/)[0].trim().toUpperCase(); if (v) _dpLoad(v);
  });
  document.getElementById("wt-dp-filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]"); if (!b) return;
    _dpState.filter = b.dataset.f;
    document.querySelectorAll("#wt-dp-filters button").forEach((x) => x.classList.toggle("active", x === b));
    _dpRender();
  });
  await _dpLoad(_dpState.ticker);
}
async function _dpLoad(ticker) {
  _dpState.ticker = ticker;
  document.querySelectorAll("#wt-dp-chips .wt-octk").forEach((x) => x.classList.toggle("active", x.dataset.dptk === ticker));
  const list = document.getElementById("wt-dp-list"); const stats = document.getElementById("wt-dp-stats");
  if (!list) return;
  list.innerHTML = `<p class="dash-empty">Loading…</p>`;
  let d;
  try { d = await _whaleGet(`/api/whale/darkpool${ticker ? `?ticker=${encodeURIComponent(ticker)}` : ""}`); }
  catch { list.innerHTML = `<p class="dash-empty">Could not load.</p>`; return; }
  if (_dpState.ticker !== ticker) return;   // superseded by a newer query
  _dpState.data = d;
  const filters = document.getElementById("wt-dp-filters");
  if (filters) filters.style.display = ticker ? "none" : "";
  const s = d.summary || {};
  if (ticker) {
    const e = (d.entries || [])[0];
    const hist = d.history || [];
    const avgDp = hist.length ? (hist.reduce((a, h) => a + h.darkPoolPct, 0) / hist.length).toFixed(1) : "—";
    if (e) {
      stats.innerHTML = `
        <div class="wt-ostat"><span class="wt-ostat-l">DARK POOL %</span><span class="wt-ostat-v ${e.signal === "bullish" ? "up" : e.signal === "bearish" ? "down" : ""}">${e.darkPoolPct}%</span><span class="wt-ostat-s">non-short share</span></div>
        <div class="wt-ostat"><span class="wt-ostat-l">SHORT %</span><span class="wt-ostat-v">${e.shortPct}%</span></div>
        <div class="wt-ostat"><span class="wt-ostat-l">TOTAL VOLUME</span><span class="wt-ostat-v">${_wNum(e.totalVolume)}</span><span class="wt-ostat-s">short ${_wNum(e.shortVolume)}</span></div>
        <div class="wt-ostat"><span class="wt-ostat-l">${hist.length}-DAY AVG DP</span><span class="wt-ostat-v">${avgDp}%</span></div>
        <div class="wt-ostat"><span class="wt-ostat-l">SIGNAL</span><span class="wt-ostat-v"><span class="wt-sig ${e.signal}">${e.signal}</span></span></div>`;
    } else { stats.innerHTML = ""; }
  } else {
    stats.innerHTML = `
      <div class="wt-ostat"><span class="wt-ostat-l">TRACKED</span><span class="wt-ostat-v">${s.tracked ?? 0}</span><span class="wt-ostat-s">high-volume names</span></div>
      <div class="wt-ostat"><span class="wt-ostat-l">🟢 ACCUMULATION</span><span class="wt-ostat-v up">${s.bullish ?? 0}</span><span class="wt-ostat-s">short &lt; 32%</span></div>
      <div class="wt-ostat"><span class="wt-ostat-l">🔴 DISTRIBUTION</span><span class="wt-ostat-v down">${s.bearish ?? 0}</span><span class="wt-ostat-s">short &gt; 50%</span></div>
      <div class="wt-ostat"><span class="wt-ostat-l">NEUTRAL</span><span class="wt-ostat-v">${s.neutral ?? 0}</span></div>
      <div class="wt-ostat"><span class="wt-ostat-l">AVG DARK POOL %</span><span class="wt-ostat-v">${s.avgDarkPoolPct ?? "—"}%</span><span class="wt-ostat-s">vol-weighted</span></div>`;
  }
  _dpRender();
}
function _dpRender() {
  const list = document.getElementById("wt-dp-list"); const d = _dpState.data; if (!list || !d) return;
  const note = `<div class="dim wt-note">Short volume &lt;32% = accumulation (buyers absorbing supply), &gt;50% = distribution. ${d.date ? `FINRA Reg SHO · ${d.date}` : ""}</div>`;
  // Per-ticker multi-day trend.
  let trend = "";
  if (_dpState.ticker && (d.history || []).length) {
    const h = d.history;
    const cols = h.map((p) => {
      const sig = p.shortPct < 32 ? "bullish" : p.shortPct > 50 ? "bearish" : "neutral";
      return `<div class="wt-dp-histcol" title="${p.date.slice(4, 6)}/${p.date.slice(6, 8)} · ${p.darkPoolPct}% dark pool · vol ${_wNum(p.totalVolume)}">
        <div class="wt-dp-histbar ${sig}" style="height:${Math.max(2, Math.min(100, p.darkPoolPct))}%"></div>
        <span class="wt-dp-histlbl">${p.date.slice(4, 6)}/${p.date.slice(6, 8)}</span></div>`;
    }).join("");
    trend = `<div class="wt-dp-trend"><div class="wt-dp-trend-h">${_esc(_dpState.ticker)} · dark-pool % trend (last ${h.length} sessions)</div><div class="wt-dp-hist">${cols}</div></div>`;
  }
  let e = d.entries || [];
  if (!_dpState.ticker) {
    const f = _dpState.filter;
    if (f !== "all") e = e.filter((r) => r.signal === f);
  }
  if (!e.length && !trend) { list.innerHTML = `<p class="dash-empty">No FINRA data yet (the daily file posts after market close).</p>`; return; }
  const rows = e.slice(0, 150).map((r) => `<tr>
    <td><b>${_esc(r.symbol)}</b></td><td>${_wNum(r.totalVolume)}</td>
    <td class="dim">${_wNum(r.shortVolume)}</td><td class="dim">${_wNum(r.shortExempt)}</td>
    <td>${r.shortPct}%</td>
    <td><span class="wt-dpbar"><span style="width:${Math.min(100, r.darkPoolPct)}%"></span></span>${r.darkPoolPct}%</td>
    <td><span class="wt-sig ${r.signal}">${r.signal}</span></td></tr>`).join("");
  const table = rows ? `<div class="wt-tablewrap"><table class="wt-table"><thead><tr>
    <th>Ticker</th><th>Total Vol</th><th>Short Vol</th><th>Short Exempt</th><th>Short %</th><th>Dark Pool %</th><th>Signal</th></tr></thead><tbody>${rows}</tbody></table></div>` : "";
  list.innerHTML = note + trend + table;
}

let _whaleInvData = null;
const _INV_ORDER = ["berkshire", "munger", "ackman", "burry", "ark", "pabrai", "druckenmiller"];
const _PIE_COLORS = ["#4b9eff", "#00e5a0", "#f5a623", "#a855f7", "#ff6b6b", "#34d399", "#f59e0b", "#60a5fa", "#c084fc", "#fb7185", "#2dd4bf", "#e879a6"];

async function renderWhaleInvestors(body, gen) {
  const d = await _whaleGet("/api/whale/investors");
  if (_whaleStale(gen)) return;
  const ids = Object.keys(d).filter((id) => (d[id].holdings || []).length);
  if (!ids.length) { body.innerHTML = `<p class="dash-empty">Could not load 13F data.</p>`; return; }
  _whaleInvData = d;
  const order = _INV_ORDER.filter((id) => ids.includes(id)).concat(ids.filter((id) => !_INV_ORDER.includes(id)));
  const sel = `<button class="wt-invchip active" data-inv="aggregate"><span class="wt-inv-av">🧮</span> All whales</button>` +
    order.map((id) => `<button class="wt-invchip" data-inv="${id}"><span class="wt-inv-av">${d[id].avatar || "📈"}</span> ${_esc(d[id].name)}</button>`).join("");
  body.innerHTML = `<div class="wt-invsel" id="wt-invsel">${sel}</div><div class="wt-invdetail" id="wt-invdetail"></div>`;
  document.getElementById("wt-invsel").addEventListener("click", (e) => {
    const b = e.target.closest(".wt-invchip"); if (!b) return;
    document.querySelectorAll("#wt-invsel .wt-invchip").forEach((x) => x.classList.toggle("active", x === b));
    _renderInvestorDetail(b.dataset.inv);
  });
  _renderInvestorDetail("aggregate");
}
// Sum all 7 portfolios by holding (ticker, else issuer name) → consensus book.
function _investorAggregate(d, ids) {
  const agg = {};
  for (const id of ids) {
    for (const h of (d[id].holdings || [])) {
      if (h.isOption) continue;   // skip puts/calls in the consensus
      const key = (h.ticker || h.name || "").toUpperCase().trim(); if (!key) continue;
      const a = agg[key] || (agg[key] = { name: h.name, ticker: h.ticker, value: 0, holders: 0 });
      a.value += h.value || 0; a.holders += 1;
    }
  }
  const total = Object.values(agg).reduce((s, a) => s + a.value, 0) || 1;
  return Object.values(agg).map((a) => ({ ...a, pct: Math.round(a.value / total * 1000) / 10 })).sort((x, y) => y.value - x.value);
}
// Build a conic-gradient donut + legend from rows (top 10 + "Other").
function _piHtml(rows, labelFn) {
  const top = rows.slice(0, 10).map((r, i) => ({ label: labelFn(r), pct: r.pct, color: _PIE_COLORS[i % _PIE_COLORS.length] }));
  const rest = rows.slice(10).reduce((s, r) => s + r.pct, 0);
  if (rest > 0.05) top.push({ label: `Other (${rows.length - 10})`, pct: Math.round(rest * 10) / 10, color: "#5b6473" });
  let acc = 0;
  const stops = top.map((s) => { const a = acc; acc += s.pct; return `${s.color} ${a.toFixed(2)}% ${Math.min(100, acc).toFixed(2)}%`; }).join(", ");
  const legend = top.map((s) => `<div class="wt-leg"><span class="wt-sw" style="background:${s.color}"></span><span class="wt-leg-l">${_esc(s.label)}</span><span class="wt-leg-p">${s.pct.toFixed(1)}%</span></div>`).join("");
  return `<div class="wt-pieWrap"><div class="wt-pie" style="background:conic-gradient(${stops})"></div><div class="wt-legend">${legend}</div></div>`;
}
function _renderInvestorDetail(which) {
  const d = _whaleInvData; if (!d) return;
  const detail = document.getElementById("wt-invdetail"); if (!detail) return;
  const ids = Object.keys(d).filter((id) => (d[id].holdings || []).length);
  if (which === "aggregate") {
    const rows = _investorAggregate(d, ids);
    const total = rows.reduce((s, r) => s + r.value, 0);
    const tbl = rows.slice(0, 30).map((r) => `<tr><td>${r.ticker ? `<b>${_esc(r.ticker)}</b> ` : ""}${_esc(r.name)}</td><td>${_wUsd(r.value)}</td><td>${r.pct}%</td><td class="dim">${r.holders} of ${ids.length}</td></tr>`).join("");
    detail.innerHTML = `<div class="wt-inv-dethead"><span class="wt-inv-av big">🧮</span>
        <div class="wt-inv-id"><div class="wt-inv-name">All whales combined</div><div class="dim">${ids.length} portfolios · ${_wUsd(total)} total 13F value</div></div></div>
      ${_piHtml(rows, (r) => r.ticker || r.name)}
      <table class="wt-table sm"><thead><tr><th>Holding</th><th>Combined value</th><th>Weight</th><th>Held by</th></tr></thead><tbody>${tbl}</tbody></table>`;
    return;
  }
  const inv = d[which]; if (!inv) return;
  const hold = (inv.holdings || []).filter((h) => !h.isOption).map((h) => ({ pct: h.pctPortfolio, name: h.name, ticker: h.ticker }));
  const tbl = (inv.holdings || []).map((h) => `<tr><td>${h.ticker ? `<b>${_esc(h.ticker)}</b> ` : ""}${_esc(h.name)}${h.isOption ? ` <span class="wt-opt">${_esc(h.putCall)}</span>` : ""}</td><td>${_wUsd(h.value)}</td><td>${h.pctPortfolio}%</td></tr>`).join("");
  // Wikipedia photo if available, else the emoji avatar; onerror falls back too.
  const avatar = inv.photo
    ? `<img class="wt-inv-photo" src="${_esc(inv.photo)}" alt="${_esc(inv.name)}" loading="lazy" onerror="this.outerHTML='<span class=\\'wt-inv-av big\\'>${inv.avatar || "📈"}</span>'">`
    : `<span class="wt-inv-av big">${inv.avatar || "📈"}</span>`;
  const bio = inv.bio
    ? `<p class="wt-inv-bio">${_esc(inv.bio)}${inv.wikiUrl ? ` <a href="${_esc(inv.wikiUrl)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}</p>`
    : "";
  detail.innerHTML = `<div class="wt-inv-dethead">${avatar}
      <div class="wt-inv-id"><div class="wt-inv-name">${_esc(inv.name)}</div><div class="dim">${_esc(inv.fund)} · ${_esc(inv.strategy || "")}</div></div>
      <div class="wt-inv-aum">${_esc(inv.aum || "—")}<span class="dim">${_esc(inv.filingDate || "")}</span></div></div>
    ${bio}
    ${hold.length ? _piHtml(hold, (r) => r.ticker || r.name) : ""}
    <table class="wt-table sm"><thead><tr><th>Holding</th><th>Value</th><th>% Portfolio</th></tr></thead><tbody>${tbl}</tbody></table>`;
}

async function renderWhaleCrypto(body, gen) {
  const d = await _whaleGet("/api/whale/crypto");
  if (_whaleStale(gen)) return;
  const w = d.wallets || []; const pr = d.prices || {};
  const head = `<div class="wt-cryptoprices">
    <span>BTC ${_wUsd(pr.btc)} <b class="${(pr.btcChange || 0) >= 0 ? "up" : "down"}">${_wPct(pr.btcChange)}</b></span>
    <span>ETH ${_wUsd(pr.eth)} <b class="${(pr.ethChange || 0) >= 0 ? "up" : "down"}">${_wPct(pr.ethChange)}</b></span></div>`;
  const cards = w.map((x) => `<div class="wt-wallet">
    <div class="wt-wal-top"><span class="wt-chain ${x.chain}">${x.chain}</span><b>${_esc(x.name)}</b>${x.verified ? ` <i data-lucide="badge-check" class="wt-verified"></i>` : ""}</div>
    <div class="dim">${_esc(x.label)}</div>
    <div class="wt-wal-bal">${_wNum(x.balance)} ${x.chain} <span class="dim">${x.balanceLive ? "live" : "est."}</span></div>
    <div class="wt-wal-usd">${_wUsd(x.balanceUsd)}</div>
    <div class="wt-wal-addr dim" title="${_esc(x.address)}">${_esc(x.address.slice(0, 12))}…${_esc(x.address.slice(-6))}</div>
  </div>`).join("");
  body.innerHTML = `${head}<div class="wt-wallets">${cards}</div>`;
}

// Heatmap ticker groups (ported from Whale-Watcher). ~114 tickers across 5 groups.
const WHALE_HEAT_GROUPS = [
  { label: "S&P 500 SECTORS", color: "#4b9eff", tickers: [
    { ticker: "XLK", name: "Technology" }, { ticker: "XLF", name: "Financials" }, { ticker: "XLV", name: "Health Care" },
    { ticker: "XLY", name: "Cons. Disc." }, { ticker: "XLC", name: "Comm. Svcs" }, { ticker: "XLI", name: "Industrials" },
    { ticker: "XLE", name: "Energy" }, { ticker: "XLP", name: "Cons. Staples" }, { ticker: "XLB", name: "Materials" },
    { ticker: "XLRE", name: "Real Estate" }, { ticker: "XLU", name: "Utilities" }, { ticker: "SPY", name: "S&P 500" },
    { ticker: "QQQ", name: "Nasdaq 100" }, { ticker: "IWM", name: "Russell 2000" }, { ticker: "DIA", name: "Dow Jones" } ] },
  { label: "MEGA CAPS", color: "#00e5a0", tickers: [
    { ticker: "NVDA", name: "NVIDIA" }, { ticker: "AAPL", name: "Apple" }, { ticker: "MSFT", name: "Microsoft" },
    { ticker: "AMZN", name: "Amazon" }, { ticker: "GOOGL", name: "Alphabet" }, { ticker: "META", name: "Meta" },
    { ticker: "TSLA", name: "Tesla" }, { ticker: "BRK-B", name: "Berkshire" }, { ticker: "JPM", name: "JPMorgan" },
    { ticker: "V", name: "Visa" }, { ticker: "UNH", name: "UnitedHealth" }, { ticker: "AVGO", name: "Broadcom" },
    { ticker: "LLY", name: "Eli Lilly" }, { ticker: "XOM", name: "ExxonMobil" }, { ticker: "MA", name: "Mastercard" },
    { ticker: "JNJ", name: "J&J" }, { ticker: "PG", name: "P&G" }, { ticker: "HD", name: "Home Depot" },
    { ticker: "COST", name: "Costco" }, { ticker: "WMT", name: "Walmart" }, { ticker: "NFLX", name: "Netflix" },
    { ticker: "ORCL", name: "Oracle" }, { ticker: "CRM", name: "Salesforce" }, { ticker: "AMD", name: "AMD" },
    { ticker: "QCOM", name: "Qualcomm" }, { ticker: "TXN", name: "Texas Instruments" }, { ticker: "INTU", name: "Intuit" },
    { ticker: "AMAT", name: "Appl. Materials" }, { ticker: "MU", name: "Micron" }, { ticker: "PLTR", name: "Palantir" },
    { ticker: "BAC", name: "Bank of America" }, { ticker: "GS", name: "Goldman Sachs" }, { ticker: "ABBV", name: "AbbVie" },
    { ticker: "TMO", name: "Thermo Fisher" }, { ticker: "ACN", name: "Accenture" } ] },
  { label: "CRYPTO", color: "#f5a623", tickers: [
    { ticker: "BTC-USD", name: "Bitcoin" }, { ticker: "ETH-USD", name: "Ethereum" }, { ticker: "SOL-USD", name: "Solana" },
    { ticker: "BNB-USD", name: "BNB" }, { ticker: "XRP-USD", name: "XRP" }, { ticker: "DOGE-USD", name: "Dogecoin" },
    { ticker: "ADA-USD", name: "Cardano" }, { ticker: "AVAX-USD", name: "Avalanche" }, { ticker: "SHIB-USD", name: "Shiba Inu" },
    { ticker: "LINK-USD", name: "Chainlink" }, { ticker: "LTC-USD", name: "Litecoin" }, { ticker: "BCH-USD", name: "Bitcoin Cash" },
    { ticker: "DOT-USD", name: "Polkadot" }, { ticker: "UNI-USD", name: "Uniswap" }, { ticker: "ATOM-USD", name: "Cosmos" },
    { ticker: "NEAR-USD", name: "NEAR" }, { ticker: "ICP-USD", name: "Internet Computer" }, { ticker: "FIL-USD", name: "Filecoin" },
    { ticker: "ARB-USD", name: "Arbitrum" }, { ticker: "MSTR", name: "MicroStrategy" }, { ticker: "COIN", name: "Coinbase" },
    { ticker: "HOOD", name: "Robinhood" }, { ticker: "MARA", name: "Marathon Digital" }, { ticker: "CLSK", name: "CleanSpark" } ] },
  { label: "HIGH MOMENTUM", color: "#a855f7", tickers: [
    { ticker: "SMCI", name: "Super Micro" }, { ticker: "ARM", name: "ARM Holdings" }, { ticker: "RKLB", name: "Rocket Lab" },
    { ticker: "IONQ", name: "IonQ" }, { ticker: "RGTI", name: "Rigetti" }, { ticker: "LUNR", name: "Intuitive Machines" },
    { ticker: "ACHR", name: "Archer Aviation" }, { ticker: "SHOP", name: "Shopify" }, { ticker: "SNOW", name: "Snowflake" },
    { ticker: "AI", name: "C3.ai" }, { ticker: "PATH", name: "UiPath" }, { ticker: "SOUN", name: "SoundHound AI" },
    { ticker: "BBAI", name: "BigBear.ai" }, { ticker: "QBTS", name: "D-Wave" }, { ticker: "QUBT", name: "Quantum Computing" },
    { ticker: "BTDR", name: "Bitdeer" }, { ticker: "CAVA", name: "CAVA Group" }, { ticker: "DUOL", name: "Duolingo" },
    { ticker: "CELH", name: "Celsius" }, { ticker: "UPST", name: "Upstart" }, { ticker: "U", name: "Unity" },
    { ticker: "CRSP", name: "CRISPR" }, { ticker: "BEAM", name: "Beam Therapeutics" }, { ticker: "CRDO", name: "Credo" },
    { ticker: "APP", name: "AppLovin" } ] },
  { label: "BONDS & MACRO", color: "#94a3b8", tickers: [
    { ticker: "TLT", name: "20Y Treasuries" }, { ticker: "IEF", name: "7-10Y Treasuries" }, { ticker: "SHY", name: "1-3Y Treasuries" },
    { ticker: "GLD", name: "Gold" }, { ticker: "SLV", name: "Silver" }, { ticker: "GDX", name: "Gold Miners" },
    { ticker: "USO", name: "Crude Oil" }, { ticker: "UNG", name: "Natural Gas" }, { ticker: "^VIX", name: "Volatility" },
    { ticker: "UVXY", name: "Short-Term VIX" }, { ticker: "HYG", name: "High Yield Bonds" }, { ticker: "LQD", name: "Corp Bonds" },
    { ticker: "EMB", name: "EM Bonds" }, { ticker: "PDBC", name: "Commodities" }, { ticker: "BITO", name: "Bitcoin ETF" },
    { ticker: "IBIT", name: "iShares Bitcoin" }, { ticker: "WEAT", name: "Wheat" }, { ticker: "CORN", name: "Corn" } ] },
];
function _heatColor(pct) {
  const c = Math.max(-5, Math.min(5, pct));
  if (c >= 0) { const i = c / 5;
    return { bg: `rgba(0,${Math.round(160 + i * 95)},${Math.round(100 + i * 60)},${0.12 + i * 0.55})`, bd: `rgba(0,229,160,${0.08 + i * 0.45})`, tx: i > 0.3 ? "#00e5a0" : "#7a94b0" }; }
  const i = Math.abs(c) / 5;
  return { bg: `rgba(${Math.round(180 + i * 75)},${Math.round(20 + i * 15)},${Math.round(20 + i * 15)},${0.12 + i * 0.55})`, bd: `rgba(255,59,59,${0.08 + i * 0.45})`, tx: i > 0.3 ? "#ff3b3b" : "#7a94b0" };
}
function _applyHeat(quotes) {
  let g = 0, l = 0, sum = 0, n = 0;
  document.querySelectorAll("#wt-heat-groups .wt-cell").forEach((cell) => {
    const q = quotes[cell.dataset.tk];
    const pctEl = cell.querySelector(".wt-cell-pct");
    if (!q) return;
    const pct = q.changePct ?? 0; const col = _heatColor(pct);
    cell.style.background = col.bg; cell.style.borderColor = col.bd;
    pctEl.style.color = col.tx; pctEl.textContent = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
    let pr = cell.querySelector(".wt-cell-pr");
    if (!pr) { pr = document.createElement("span"); pr.className = "wt-cell-pr"; cell.appendChild(pr); }
    pr.textContent = "$" + (q.price < 1 ? q.price.toFixed(4) : q.price.toFixed(2));
    if (pct > 0) g++; else if (pct < 0) l++;
    sum += pct; n++;
  });
  const breadth = document.getElementById("wt-heat-breadth");
  if (breadth && n) {
    const avg = sum / n;
    breadth.innerHTML = `<span class="up">▲ ${g} gainers</span> · <span class="down">▼ ${l} losers</span> · avg <b class="${avg >= 0 ? "up" : "down"}">${(avg >= 0 ? "+" : "") + avg.toFixed(2)}%</b>`;
  }
}
async function renderWhaleHeatmap(body) {
  body.innerHTML = `<div class="wt-heat-bar"><div id="wt-heat-breadth" class="dim">Loading live quotes…</div>
    <div class="dim wt-note" style="margin:0">● live · refreshes every 20s</div></div><div id="wt-heat-groups"></div>`;
  document.getElementById("wt-heat-groups").innerHTML = WHALE_HEAT_GROUPS.map((grp) => `
    <div class="wt-heat-group">
      <div class="wt-heat-glabel" style="color:${grp.color}">${grp.label}</div>
      <div class="wt-heat-grid">${grp.tickers.map((t) => `<div class="wt-cell" data-tk="${t.ticker}" title="Open ${_esc(t.ticker)} on the Dashboard">
        <span class="wt-cell-tk">${_esc(t.ticker.replace("-USD", ""))}</span>
        <span class="wt-cell-nm">${_esc(t.name)}</span>
        <span class="wt-cell-pct">—</span></div>`).join("")}</div>
    </div>`).join("");
  const all = WHALE_HEAT_GROUPS.flatMap((grp) => grp.tickers.map((t) => t.ticker));
  const refresh = async () => {
    const pg = document.getElementById("page-whale");
    // Stop polling once the user leaves the heatmap tab or the page.
    if (!document.getElementById("wt-heat-groups") || !pg || !pg.classList.contains("active") || _whaleTab !== "heatmap") {
      if (_whaleTimer) { clearInterval(_whaleTimer); _whaleTimer = null; }
      return;
    }
    const chunks = [];
    for (let i = 0; i < all.length; i += 30) chunks.push(all.slice(i, i + 30));
    try {
      const res = await Promise.all(chunks.map((c) => _whaleGet(`/api/whale/stocks?tickers=${encodeURIComponent(c.join(","))}`)));
      const merged = {};
      res.forEach((r) => Object.assign(merged, r.quotes || {}));
      _applyHeat(merged);
    } catch { /* keep last frame */ }
  };
  await refresh();
  _whaleTimer = setInterval(refresh, 20000);
}

// ── Unified market calendar page (month grid: macro + earnings + economic) ──
let _calLoaded = false;
let _calData = null;             // { events: [...] }
let _calCursor = null;          // first-of-month Date currently displayed
let _calSelected = null;        // YYYY-MM-DD of the focused day
const _CAL_TYPES = { fomc: "FOMC", cpi: "Inflation", jobs: "Jobs", gdp: "GDP", earnings: "Earnings", econ: "Economic" };

async function renderCalendarPage() {
  const page = document.getElementById("page-calendar");
  if (!page) return;
  page.querySelector(".cal-wrap").innerHTML = `<p class="dash-empty">Loading calendar…</p>`;
  try {
    _calData = await (await fetch("/api/calendar")).json();
  } catch { page.querySelector(".cal-wrap").innerHTML = `<p class="dash-empty">Could not load calendar.</p>`; return; }
  const evs = _calData.events || [];
  // Default the view to the month of the next upcoming event (or today).
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = evs.find((e) => e.date >= today) || evs[evs.length - 1];
  const anchor = upcoming ? new Date(upcoming.date + "T00:00:00") : new Date();
  _calCursor = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  _calSelected = upcoming ? upcoming.date : today;
  _calDraw();
}
function _calEventsByDay() {
  const map = {};
  for (const e of (_calData?.events || [])) (map[e.date] || (map[e.date] = [])).push(e);
  return map;
}
function _calDraw() {
  const wrap = document.querySelector("#page-calendar .cal-wrap");
  if (!wrap) return;
  const byDay = _calEventsByDay();
  const y = _calCursor.getFullYear(), mo = _calCursor.getMonth();
  const monthName = _calCursor.toLocaleString("en-US", { month: "long", year: "numeric" });
  const today = new Date().toISOString().slice(0, 10);
  const first = new Date(y, mo, 1), startDow = first.getDay();
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let cells = "";
  for (let i = 0; i < startDow; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${y}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const evs = byDay[ds] || [];
    const dots = evs.slice(0, 4).map((e) => `<span class="cal-dot ${e.type}" title="${_esc(e.title)}"></span>`).join("");
    const chips = evs.slice(0, 2).map((e) => `<span class="cal-chip ${e.type}">${_esc(e.title)}</span>`).join("")
      + (evs.length > 2 ? `<span class="cal-more">+${evs.length - 2}</span>` : "");
    cells += `<div class="cal-cell${ds === today ? " today" : ""}${ds === _calSelected ? " sel" : ""}${evs.length ? " has" : ""}" data-day="${ds}">
      <div class="cal-daynum">${day}</div>${dots ? `<div class="cal-dots">${dots}</div>` : ""}<div class="cal-chips">${chips}</div></div>`;
  }
  const legend = Object.entries(_CAL_TYPES).map(([k, v]) => `<span class="cal-leg"><span class="cal-dot ${k}"></span>${v}</span>`).join("");
  const selEvs = (byDay[_calSelected] || []).slice().sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const detail = selEvs.length ? selEvs.map((e) => {
    const host = e.url ? e.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : "";
    return `<div class="cal-ev ${e.impact || "low"}" data-url="${_esc(e.url || "")}" title="${e.url ? `Open source — ${_esc(host)}` : ""}">
      <div class="cal-ev-h"><span class="cal-ev-type ${e.type}">${(_CAL_TYPES[e.type] || e.type).toUpperCase()}</span> <b>${_esc(e.title)}</b>${e.time ? `<span class="dim">${_esc(e.time)}</span>` : ""}${e.url ? `<span class="cal-ev-go">↗</span>` : ""}</div>
      ${e.desc ? `<div class="cal-ev-desc dim">${_esc(e.desc)}</div>` : ""}
      ${host ? `<div class="cal-ev-src dim">${_esc(host)}</div>` : ""}
      ${e.tickers && e.tickers.length ? `<div class="cal-ev-tk">${e.tickers.map((t) => `<span data-tk="${_esc(t)}">${_esc(t)}</span>`).join("")}</div>` : ""}</div>`;
  }).join("")
    : `<p class="dash-empty">No events on ${_esc(_calSelected || "")}.</p>`;
  wrap.innerHTML = `
    <div class="cal-grid-side">
      <div class="cal-toolbar">
        <button class="cal-nav" id="cal-prev">‹</button>
        <span class="cal-month">${monthName}</span>
        <button class="cal-nav" id="cal-next">›</button>
        <button class="cal-today" id="cal-today">Today</button>
      </div>
      <div class="cal-legend">${legend}</div>
      <div class="cal-grid">${dows.map((d) => `<div class="cal-dow">${d}</div>`).join("")}${cells}</div>
    </div>
    <aside class="cal-detail"><div class="cal-detail-h">${_esc(_calSelected || "")}</div>${detail}</aside>`;
  document.getElementById("cal-prev").addEventListener("click", () => { _calCursor = new Date(y, mo - 1, 1); _calDraw(); });
  document.getElementById("cal-next").addEventListener("click", () => { _calCursor = new Date(y, mo + 1, 1); _calDraw(); });
  document.getElementById("cal-today").addEventListener("click", () => { const n = new Date(); _calCursor = new Date(n.getFullYear(), n.getMonth(), 1); _calSelected = n.toISOString().slice(0, 10); _calDraw(); });
  wrap.querySelector(".cal-grid").addEventListener("click", (e) => {
    const c = e.target.closest(".cal-cell[data-day]"); if (!c) return;
    _calSelected = c.dataset.day; _calDraw();
  });
  wrap.querySelector(".cal-detail").addEventListener("click", (e) => {
    const t = e.target.closest("[data-tk]");
    if (t) { selectTicker(t.dataset.tk); _gotoPage("dashboard"); return; }
    const ev = e.target.closest(".cal-ev[data-url]"); if (!ev) return;
    const url = ev.dataset.url; if (url) window.open(url, "_blank", "noopener");   // open the actual source site
  });
}

// --- AI analyst chat -------------------------------------------------------
const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatText = document.getElementById("chat-text");
const chatSuggest = document.getElementById("chat-suggest");
let chatHistory = [];
let chatBusy = false;
let _chatSessionId = null;

const CHAT_WELCOME = "Macro & markets analyst online. Ask about inflation, rates, the yield curve, market news, a ticker's fundamentals/technicals, or a prior verdict — I'll reason, pull live data, and cite the source.";

function _nowLabel() {
  return new Date().toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
// Keep the conversation pinned to the bottom as it grows / streams.
// Pin the chat to the newest message. Fixed-height box, no visible bar — older
// turns simply scroll up out of view as the conversation grows. Double rAF so
// it lands after the markdown/layout reflow of the just-added content.
function _chatScroll() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    chatLog.scrollTop = chatLog.scrollHeight;
  }));
}

// Terminal-style message row: a small role label + the message body. No avatars
// or user images (kept deliberately serious). Returns the inner .bubble element
// so the streaming loop can update it in place.
function _addBubble(role, text, asHtml = false, ts) {
  const wrap = document.createElement("div");
  wrap.className = `chat-msg ${role}`;
  const col = document.createElement("div");
  col.className = "msg-col";
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.innerHTML = `<b>${role === "ai" ? "Trade Buddy" : "You"}</b> · ${_esc(ts || _nowLabel())}`;
  const b = document.createElement("div");
  b.className = "bubble";
  if (asHtml) b.innerHTML = text; else b.textContent = text;
  col.appendChild(meta); col.appendChild(b);
  wrap.appendChild(col);
  chatLog.appendChild(wrap);
  _chatScroll();
  return b;
}

function resetChatLog() { chatLog.innerHTML = ""; _addBubble("ai", _i18nTr(CHAT_WELCOME, window.__i18nLang || "English")); }

// Files the user has attached to the next message (text extracted in-browser).
let _chatAttachments = [];

async function sendChat(message) {
  const atts = _chatAttachments.slice();
  if (chatBusy || (!message.trim() && !atts.length)) return;
  chatBusy = true;
  chatSuggest.classList.add("hidden");
  document.getElementById("chat-send").disabled = true;

  // What the user sees: their text + a chip per attached file.
  const chips = atts.map((a) => `<span class="att-chip">📎 ${_esc(a.name)}</span>`).join("");
  const userBubble = _addBubble("user", "", true);
  userBubble.innerHTML = (message ? _esc(message) : "") + (chips ? `<div class="att-chips">${chips}</div>` : "");

  // What the agent receives: the message plus each file's text as context.
  let augmented = message;
  for (const a of atts) {
    augmented += `\n\n[Attached file: ${a.name}]\n\`\`\`\n${a.text.slice(0, 8000)}\n\`\`\``;
  }
  _clearChatAttachments();
  chatHistory.push({ role: "user", content: augmented });
  const thinking = _addBubble("ai", "Thinking…");
  const thinkingMsg = thinking.closest(".chat-msg");
  thinkingMsg.classList.add("thinking");
  let finalText = "";
  // v4/reasoner models stream chain-of-thought separately ("reasoning" events).
  // Show it in a collapsible block above the answer so it never mixes into the
  // reply; it auto-collapses once the actual answer starts streaming.
  let reasoning = "";
  let reasonBody = null;
  const _ensureReasonBox = () => {
    if (reasonBody) return reasonBody;
    const col = thinking.closest(".msg-col") || thinking.parentElement;
    const det = document.createElement("details");
    det.className = "chat-think"; det.open = true;
    det.innerHTML = `<summary>Thinking…</summary><div class="chat-think-body"></div>`;
    col.insertBefore(det, thinking);
    reasonBody = det.querySelector(".chat-think-body");
    reasonBody._det = det;
    return reasonBody;
  };
  const _clearThinkingPlaceholder = () => {
    if (thinkingMsg.classList.contains("thinking")) {
      thinkingMsg.classList.remove("thinking");
      thinking.textContent = "";
    }
  };
  try {
    const model = (document.getElementById("chat-model") || {}).value || "deepseek-chat";
    const r = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: augmented, history: chatHistory.slice(0, -1), provider: "deepseek", model }),
    });
    // Stream Server-Sent Events from the POST response body.
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === "status") {
          if (!finalText && !reasoning) thinking.textContent = ev.text;  // only before output
        } else if (ev.type === "reasoning") {
          _clearThinkingPlaceholder();
          reasoning += ev.text;
          _ensureReasonBox().textContent = reasoning;
          _chatScroll();
        } else if (ev.type === "token") {
          _clearThinkingPlaceholder();
          // collapse the thinking block once the real answer begins
          if (reasonBody && reasonBody._det.dataset.collapsed !== "1") {
            reasonBody._det.open = false;
            reasonBody._det.dataset.collapsed = "1";
            reasonBody._det.querySelector("summary").textContent = "Thoughts";
          }
          finalText += ev.text;
          thinking.textContent = finalText;                    // live plain-text stream
          _chatScroll();
        } else if (ev.type === "done") {
          finalText = ev.text || finalText || "(no response)";
        }
      }
    }
    thinkingMsg.classList.remove("thinking");
    thinking.innerHTML = (window.marked ? marked.parse(finalText) : _esc(finalText));
    _chatScroll();   // markdown reflow can change height — re-pin to the bottom
    chatHistory.push({ role: "assistant", content: finalText });
    _saveChatSession();
  } catch {
    thinkingMsg.classList.remove("thinking");
    thinking.textContent = "⚠️ Could not reach the analyst.";
  } finally {
    chatBusy = false;
    document.getElementById("chat-send").disabled = false;
    _chatScroll();
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = chatText.value.trim();
  if (!msg && !_chatAttachments.length) return;
  chatText.value = ""; _growChatBox();
  sendChat(msg);
});

// --- File attachments (text extracted in the browser; DeepSeek is text-only) ---
const _ATT_OK = /\.(txt|csv|tsv|md|json|log|py|text)$/i;
function _renderChatAttachments() {
  const wrap = document.getElementById("chat-attach-list"); if (!wrap) return;
  wrap.innerHTML = _chatAttachments.map((a, i) =>
    `<span class="att-chip">📎 ${_esc(a.name)} <button type="button" data-att="${i}" aria-label="Remove">×</button></span>`).join("");
}
function _clearChatAttachments() { _chatAttachments = []; _renderChatAttachments(); }
document.getElementById("chat-attach-btn")?.addEventListener("click", () =>
  document.getElementById("chat-file")?.click());
document.getElementById("chat-file")?.addEventListener("change", async (e) => {
  for (const f of [...e.target.files]) {
    if (!_ATT_OK.test(f.name)) {
      _addBubble("ai", `⚠️ "${f.name}" isn't a supported text file. Upload .txt/.csv/.md/.json (DeepSeek can't read PDFs or images — paste the text instead).`);
      continue;
    }
    if (f.size > 1_000_000) { _addBubble("ai", `⚠️ "${f.name}" is too large (max ~1 MB of text).`); continue; }
    try { _chatAttachments.push({ name: f.name, text: await f.text() }); } catch { /* skip */ }
  }
  e.target.value = "";   // allow re-selecting the same file
  _renderChatAttachments();
});
document.getElementById("chat-attach-list")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-att]"); if (!b) return;
  _chatAttachments.splice(+b.dataset.att, 1); _renderChatAttachments();
});
// Enter sends; Shift+Enter inserts a newline. Textarea auto-grows to a cap.
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chatForm.requestSubmit(); }
});
function _growChatBox() { chatText.style.height = "auto"; chatText.style.height = Math.min(chatText.scrollHeight, 160) + "px"; }
chatText.addEventListener("input", _growChatBox);
chatSuggest.addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  sendChat(btn.textContent);
});

// --- Sessions: localStorage-backed history + New session -------------------
const CHAT_STORE = "tb_chat_sessions";
function _loadSessions() { try { return JSON.parse(localStorage.getItem(CHAT_STORE)) || []; } catch { return []; } }
function _saveSessions(s) { try { localStorage.setItem(CHAT_STORE, JSON.stringify(s.slice(0, 40))); } catch {} }
function _saveChatSession() {
  if (!chatHistory.length) return;
  const sessions = _loadSessions();
  const title = (chatHistory.find((m) => m.role === "user") || {}).content || "Session";
  const rec = { id: _chatSessionId || Date.now(), ts: Date.now(), title: title.slice(0, 80), msgs: chatHistory.slice() };
  _chatSessionId = rec.id;
  const i = sessions.findIndex((s) => s.id === rec.id);
  if (i >= 0) sessions[i] = rec; else sessions.unshift(rec);
  _saveSessions(sessions);
}
function newChatSession() {
  chatHistory = []; _chatSessionId = null;
  resetChatLog();
  chatSuggest.classList.remove("hidden");
  _hideChatHistory();
}
function _hideChatHistory() { document.getElementById("chat-history-panel").classList.add("hidden"); }
function _relTimeMs(ts) {  // ms-epoch variant for chat sessions
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function _renderChatHistory() {
  const panel = document.getElementById("chat-history-panel");
  const L = window.__i18nLang || "English";
  const sessions = _loadSessions();
  if (!sessions.length) {
    panel.innerHTML = `<li class="chat-hist-empty">${_i18nTr("No past sessions yet.", L)}</li>`;
    panel.classList.remove("hidden");
    return;
  }
  const rows = sessions.map((s) => `<li class="chat-hist-item" data-id="${s.id}">
        <input type="checkbox" class="chi-check" data-id="${s.id}" aria-label="Select session" />
        <div class="chi-body">
          <div class="chi-title">${_esc(s.title)}</div>
          <div class="chi-meta">${s.msgs.filter((m) => m.role === "user").length} msgs · ${_relTimeMs(s.ts)}</div>
        </div>
        <button type="button" class="chi-del" data-del="${s.id}" title="${_i18nTr("Delete session", L)}" aria-label="Delete session">✕</button></li>`).join("");
  // A bulk-action bar lets the user tick several sessions and remove them at once.
  panel.innerHTML = `<li class="chat-hist-bar">
      <label class="chi-all"><input type="checkbox" id="chi-all" /> ${_i18nTr("Select all", L)}</label>
      <button type="button" class="chi-delsel" id="chi-delsel" disabled>${_i18nTr("Delete selected", L)}</button>
    </li>` + rows;
  panel.classList.remove("hidden");
  _updateBulkBtn();
}
function _updateBulkBtn() {
  const btn = document.getElementById("chi-delsel");
  if (!btn) return;
  const boxes = [...document.querySelectorAll("#chat-history-panel .chi-check")];
  const n = boxes.filter((c) => c.checked).length;
  const L = window.__i18nLang || "English";
  btn.disabled = n === 0;
  btn.textContent = n ? `${_i18nTr("Delete selected", L)} (${n})` : _i18nTr("Delete selected", L);
  const all = document.getElementById("chi-all");
  if (all) { all.checked = n > 0 && n === boxes.length; all.indeterminate = n > 0 && n < boxes.length; }
}
function toggleChatHistory() {
  const panel = document.getElementById("chat-history-panel");
  if (!panel.classList.contains("hidden")) { panel.classList.add("hidden"); return; }
  _renderChatHistory();
}
function deleteChatSessions(ids) {
  const set = new Set(ids.map(String));
  if (!set.size) return;
  _saveSessions(_loadSessions().filter((s) => !set.has(String(s.id))));
  // If the open session was among those deleted, drop back to a blank session
  // (newChatSession hides the panel, so re-render re-opens it).
  if (set.has(String(_chatSessionId))) newChatSession();
  _renderChatHistory();
}
function deleteChatSession(id) { deleteChatSessions([id]); }
function loadChatSession(id) {
  const sess = _loadSessions().find((s) => String(s.id) === String(id));
  if (!sess) return;
  _chatSessionId = sess.id;
  chatHistory = sess.msgs.slice();
  chatLog.innerHTML = "";
  _addBubble("ai", _i18nTr(CHAT_WELCOME, window.__i18nLang || "English"));
  for (const m of chatHistory) {
    if (m.role === "user") _addBubble("user", m.content);
    else _addBubble("ai", (window.marked ? marked.parse(m.content) : _esc(m.content)), true);
  }
  chatSuggest.classList.add("hidden");
  _hideChatHistory();
  _chatScroll();
}
document.getElementById("chat-new-btn").addEventListener("click", newChatSession);
document.getElementById("chat-history-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleChatHistory(); });
// Draggable divider between the company-analysis panel and the chat. Pulling the
// handle left shrinks the left column (--ai-left) so the chat grows, and vice
// versa. The width is remembered across sessions.
(function initAiResizer() {
  const resizer = document.getElementById("ai-resizer");
  const ws = document.querySelector(".ai-workspace");
  if (!resizer || !ws) return;
  const MIN = 180, RESIZER = 8;        // keep the analysis panel usable, never 0
  try {
    const saved = parseInt(localStorage.getItem("tb_ai_left") || "", 10);
    // Ignore a stale/collapsed saved width so the panel can't look "stuck".
    if (saved >= MIN) ws.style.setProperty("--ai-left", saved + "px");
  } catch {}
  let dragging = false;
  const onMove = (clientX) => {
    const rect = ws.getBoundingClientRect();
    let left = clientX - rect.left;
    const max = rect.width - RESIZER - 300;   // keep at least ~300px for the chat
    left = Math.max(MIN, Math.min(left, Math.max(MIN, max)));
    const val = left + "px";
    ws.style.setProperty("--ai-left", val);
    try { localStorage.setItem("tb_ai_left", val); } catch {}
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.classList.remove("ai-resizing");
    window.removeEventListener("pointermove", pm);
    window.removeEventListener("pointerup", stop);
  };
  const pm = (e) => { if (dragging) onMove(e.clientX); };
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add("dragging");
    document.body.classList.add("ai-resizing");
    window.addEventListener("pointermove", pm);
    window.addEventListener("pointerup", stop);
  });
  // Double-click the handle to reset to the default split.
  resizer.addEventListener("dblclick", () => {
    ws.style.removeProperty("--ai-left");
    try { localStorage.removeItem("tb_ai_left"); } catch {}
  });
})();
document.getElementById("chat-history-panel").addEventListener("click", (e) => {
  const L = window.__i18nLang || "English";
  // Ticking a row's checkbox (or "select all") only updates the selection.
  if (e.target.closest(".chi-check")) { e.stopPropagation(); _updateBulkBtn(); return; }
  if (e.target.id === "chi-all") {
    e.stopPropagation();
    const on = e.target.checked;
    document.querySelectorAll("#chat-history-panel .chi-check").forEach((c) => { c.checked = on; });
    _updateBulkBtn();
    return;
  }
  const bulk = e.target.closest("#chi-delsel");
  if (bulk) {   // delete every ticked session at once
    e.stopPropagation();
    const ids = [...document.querySelectorAll("#chat-history-panel .chi-check:checked")].map((c) => c.dataset.id);
    if (ids.length && confirm(_i18nTr("Delete the selected sessions?", L))) deleteChatSessions(ids);
    return;
  }
  const del = e.target.closest(".chi-del");
  if (del) {   // delete this one session (don't also load it)
    e.stopPropagation();
    if (confirm(_i18nTr("Delete this chat session?", L))) deleteChatSession(del.dataset.del);
    return;
  }
  const item = e.target.closest(".chat-hist-item"); if (!item || !item.dataset.id) return;
  loadChatSession(item.dataset.id);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#chat-history-panel") && !e.target.closest("#chat-history-btn")) _hideChatHistory();
});

resetChatLog();  // initial welcome message

// --------------------------------------------------------------------------- //
// Watchlist
// --------------------------------------------------------------------------- //
let _watchSymbols = [];

function _miniSpark(spark, up) {
  if (!spark || spark.length < 2) return "";
  const min = Math.min(...spark), max = Math.max(...spark), rng = (max - min) || 1;
  const W = 70, H = 26;
  const pts = spark.map((v, i) => `${(i / (spark.length - 1) * W).toFixed(1)},${(H - (v - min) / rng * (H - 4) - 2).toFixed(1)}`).join(" ");
  return `<svg class="wl-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${up ? "var(--up)" : "var(--down)"}" stroke-width="1.5"/></svg>`;
}
function _wlRowHtml(r, withRemove) {
  const up = (r.change_pct ?? 0) >= 0;
  const price = r.price != null ? r.price.toFixed(2) : "—";
  const pct = r.change_pct != null ? `${up ? "+" : ""}${r.change_pct.toFixed(2)}%` : "";
  return `<div class="wl-row" data-sym="${r.symbol}">
      <div class="wl-id"><span class="wl-sym">${_esc(r.symbol)}</span><span class="wl-name">${_esc(r.name || "")}</span></div>
      ${_miniSpark(r.spark, up)}
      <div class="wl-px"><span class="wl-last">${price}</span><span class="wl-chg ${up ? "up" : "down"}">${pct}</span></div>
      ${withRemove ? `<button class="wl-rm" data-rm="${r.symbol}" title="Remove">✕</button>` : ""}
    </div>`;
}
async function loadWatchlist() {
  let data;
  try { data = await (await fetch("/api/watchlist")).json(); }
  catch { return; }
  _watchSymbols = data.symbols || [];
  const rows = data.rows || [];
  const rail = document.getElementById("wl-list");
  const table = document.getElementById("wl-table");
  if (!rows.length) {
    rail.innerHTML = `<p class="dash-empty">Add a ticker with the ☆ to track it here.</p>`;
    table.innerHTML = `<p class="dash-empty">Add stocks with the ☆ next to a ticker.</p>`;
  } else {
    rail.innerHTML = rows.map((r) => _wlRowHtml(r, false)).join("");
    table.innerHTML = rows.map((r) => _wlRowHtml(r, true)).join("");
  }
  _syncStar();
}
function _syncStar() {
  const star = document.getElementById("q-star");
  if (!star || !currentTicker) return;
  star.hidden = false;
  const on = _watchSymbols.includes(currentTicker.toUpperCase());
  star.textContent = on ? "★" : "☆";
  star.classList.toggle("on", on);
}
async function toggleWatch(symbol) {
  if (!symbol) return;
  const on = _watchSymbols.includes(symbol.toUpperCase());
  try {
    if (on) await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
    else await fetch("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol }) });
  } catch { return; }
  await loadWatchlist();
}
document.getElementById("q-star").addEventListener("click", () => toggleWatch(currentTicker));
document.getElementById("wl-refresh").addEventListener("click", loadWatchlist);
// Click a watchlist row → open that ticker; ✕ → remove.
document.querySelector(".app").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-rm]");
  if (rm) { e.stopPropagation(); toggleWatch(rm.dataset.rm); return; }
  const row = e.target.closest(".wl-row");
  if (row) { searchEl.value = row.dataset.sym; selectTicker(row.dataset.sym); }
});

// --------------------------------------------------------------------------- //
// Economy indicator → click-through line chart
// --------------------------------------------------------------------------- //
const econModal = document.getElementById("econ-modal");
document.getElementById("em-close").addEventListener("click", () => { econModal.hidden = true; });
econModal.addEventListener("click", (e) => { if (e.target === econModal) econModal.hidden = true; });

document.getElementById("econ-grid")?.addEventListener("click", (e) => {
  const card = e.target.closest(".econ-card-item");
  if (card && card.dataset.alias) openEconChart(card.dataset.alias, card.dataset.label);
});

let _emChart = null;       // KlineCharts instance for the macro modal
let _emFull = null;        // full series currently loaded {points, series, ...}
let _emDays = 365;         // selected window, in days (0 = MAX)

function _emInitChart() {
  const el = document.getElementById("em-chart");
  el.innerHTML = "";
  _emChart = klinecharts.init("em-chart");
  // Explicit dark palette (klinecharts 9.8 has no built-in "dark" theme string).
  _emChart.setStyles({
    grid: { horizontal: { color: "#2a3340" }, vertical: { color: "#2a3340" } },
    candle: {
      type: "area",
      tooltip: { showRule: "none" },
    },
    xAxis: { axisLine: { color: "#2a3340" }, tickText: { color: "#8b949e" }, tickLine: { color: "#2a3340" } },
    yAxis: { type: "normal", axisLine: { color: "#2a3340" }, tickText: { color: "#8b949e" }, tickLine: { color: "#2a3340" } },
    crosshair: { horizontal: { text: { backgroundColor: "#1c2230" } }, vertical: { text: { backgroundColor: "#1c2230" } } },
  });
  new ResizeObserver(() => { if (_emChart) _emChart.resize(); }).observe(el);
}

function _emWindowedPoints() {
  const all = (_emFull && _emFull.points) || [];
  if (_emDays <= 0 || all.length < 2) return all;
  const cutoff = Date.now() - _emDays * 86400000;
  const filtered = all.filter((p) => new Date(p.date).getTime() >= cutoff);
  // Sub-year windows on a monthly series can leave <2 points — keep the last 2.
  if (filtered.length >= 2) return filtered;
  return all.slice(-2);
}

function _emUpdateChange(pts) {
  const chg = document.getElementById("em-chg");
  if (!pts || pts.length < 2) { chg.textContent = "—"; chg.className = "em-chg"; return; }
  const first = pts[0].value, last = pts[pts.length - 1].value;
  const change = last - first;
  const pct = first ? (change / first * 100) : null;
  const up = change >= 0;
  const winBtn = document.querySelector("#em-ranges button.active");
  const winLabel = winBtn ? winBtn.textContent : "";
  const pctStr = pct != null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : "";
  chg.textContent = `${winLabel}: ${up ? "▲" : "▼"} ${Math.abs(change).toFixed(2)}${pctStr} · ${pts[0].date} → ${pts[pts.length - 1].date}`;
  chg.className = "em-chg " + (up ? "up" : "down");
}

function _emRender() {
  if (!_emFull || !_emFull.points) return;
  const pts = _emWindowedPoints();
  // Update the windowed change FIRST so the header is correct even if the chart
  // engine hiccups. This is what varies with the selected window length.
  _emUpdateChange(pts);
  try {
    if (!_emChart) _emInitChart();
    const candles = pts.map((p) => ({
      timestamp: new Date(p.date).getTime(),
      open: p.value, high: p.value, low: p.value, close: p.value, volume: 0,
    }));
    _emChart.applyNewData(candles);
    const w = document.getElementById("em-chart").clientWidth || 760;
    _emChart.setDataSpace(Math.min(Math.max(Math.floor(w * 0.92 / Math.max(1, candles.length)), 2), 16));
    _emChart.scrollToRealTime();
  } catch (err) {
    console.error("macro chart render failed:", err);
  }
}

async function openEconChart(alias, label) {
  document.getElementById("em-title").textContent = label || alias;
  document.getElementById("em-sub").textContent = "Loading…";
  document.getElementById("em-val").textContent = "";
  document.getElementById("em-chg").textContent = "";
  econModal.hidden = false;
  _emFull = null;
  let d;
  try { d = await (await fetch(`/api/macro-series?indicator=${encodeURIComponent(alias)}&points=6000`)).json(); }
  catch { document.getElementById("em-sub").textContent = "Could not load series."; return; }
  if (!d.points || !d.points.length) { document.getElementById("em-sub").textContent = "No series data available."; return; }
  _emFull = d;
  document.getElementById("em-sub").textContent = `FRED: ${d.series} · ${d.points.length} observations`;
  document.getElementById("em-val").textContent = d.latest != null ? Number(d.latest).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
  // Chart + windowed change render after the modal is visible (needs a size).
  requestAnimationFrame(_emRender);
}

document.getElementById("em-ranges").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  _emDays = Number(btn.dataset.days);
  [...e.currentTarget.children].forEach((b) => b.classList.toggle("active", b === btn));
  _emRender();
});

// Tag economy cards with their alias/label so clicks know what to open.
const _origRenderCard = _renderCard;
_renderCard = function (c) {
  return _origRenderCard(c).replace(
    'class="econ-card-item"',
    `class="econ-card-item clickable" data-alias="${c.alias}" data-label="${(c.label || "").replace(/"/g, "&quot;")}"`,
  );
};

// --------------------------------------------------------------------------- //
// Init
// --------------------------------------------------------------------------- //
if (window.lucide) lucide.createIcons();   // render sidebar lucide icons
buildGraph();
initAuth();   // gate the app behind an invitation code; bootApp() runs once authed

let _authBooted = false;
function bootApp() {
  if (_authBooted) return;
  _authBooted = true;
  // Resume first and independently, so nothing else on boot can suppress it.
  try { resumeRunIfAny(); } catch (e) { console.error("resume failed", e); }
  try { loadWatchlist(); } catch (e) { console.error("watchlist failed", e); }
}

// --------------------------------------------------------------------------- //
// Backtester — author a Python strategy, run it in the sandbox, see results
// --------------------------------------------------------------------------- //
const BT_TEMPLATE = `# 20/50 SMA crossover — long when the fast SMA is above the slow SMA.
# Define generate_signals(data) -> per-bar position (-1 short, 0 flat, 1 long).
def generate_signals(data):
    fast = data["close"].rolling(20).mean()
    slow = data["close"].rolling(50).mean()
    return (fast > slow).astype(int)
`;

function initBacktester() {
  const code = document.getElementById("bt-code");
  if (code && !code.value) code.value = BT_TEMPLATE;
  const end = document.getElementById("bt-end"), start = document.getElementById("bt-start");
  const today = new Date(), prior = new Date(); prior.setFullYear(today.getFullYear() - 2);
  if (end && !end.value) end.value = today.toISOString().slice(0, 10);
  if (start && !start.value) start.value = prior.toISOString().slice(0, 10);
  document.getElementById("bt-run")?.addEventListener("click", runBacktest);
  // Changing the bar interval snaps the date window to a sensible, in-limit span
  // (~1 month for intraday, 2 years for daily) the user can still adjust.
  document.getElementById("bt-interval")?.addEventListener("change", (e) => {
    const maxDays = { "1m": 7, "5m": 59, "15m": 59, "30m": 59, "1h": 365, "1d": 365 * 2 }[e.target.value] || 30;
    const span = e.target.value === "1d" ? maxDays : Math.min(30, maxDays);  // intraday → ~1 month
    const e2 = new Date(), s2 = new Date(); s2.setDate(e2.getDate() - span);
    if (end) end.value = e2.toISOString().slice(0, 10);
    if (start) start.value = s2.toISOString().slice(0, 10);
  });

  // Syntax-highlight overlay: keep the colored <pre> in sync with the textarea.
  code?.addEventListener("input", _btSyncHighlight);
  code?.addEventListener("scroll", () => {
    const hl = document.getElementById("bt-highlight");
    if (hl) { hl.scrollTop = code.scrollTop; hl.scrollLeft = code.scrollLeft; }
  });
  code?.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = code.selectionStart, en = code.selectionEnd;
      code.value = code.value.slice(0, s) + "    " + code.value.slice(en);
      code.selectionStart = code.selectionEnd = s + 4;
      _btSyncHighlight();
    }
  });
  _btSyncHighlight();

  document.getElementById("bt-copy")?.addEventListener("click", _btCopyCode);
  document.getElementById("bt-expand")?.addEventListener("click", _btExpandEditor);
  document.getElementById("bt-modal-close")?.addEventListener("click", _btCloseEditor);
  document.getElementById("bt-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "bt-modal") _btCloseEditor();   // click backdrop to close
  });

  // Ticker autocomplete (reuses the global localRank() + /api/search).
  const tk = document.getElementById("bt-ticker"), sug = document.getElementById("bt-sug");
  tk?.addEventListener("input", () => {
    const q = tk.value.trim();
    if (!q) { _btHideSug(); return; }
    _btRunTickerSearch(q);
  });
  tk?.addEventListener("keydown", (e) => {
    if (!sug.classList.contains("show")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); _btMoveSug(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _btMoveSug(-1); }
    else if (e.key === "Enter" && btSugActive >= 0) { e.preventDefault(); _btPickSug(btSugItems[btSugActive]); }
    else if (e.key === "Escape") _btHideSug();
  });
  document.addEventListener("click", (e) => {
    if (tk && sug && !tk.contains(e.target) && !sug.contains(e.target)) _btHideSug();
  });
}

// --- Backtester ticker autosuggest ------------------------------------------
let btSugItems = [], btSugActive = -1, btLastQ = "";
async function _btRunTickerSearch(q) {
  btLastQ = q;
  btSugItems = localRank(q);
  _btRenderSug();
  try {
    const remote = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
    if (q !== btLastQ) return;
    btSugItems = _mergeItems(btSugItems, remote);
    _btRenderSug();
  } catch { /* keep local results */ }
}
function _btRenderSug() {
  const el = document.getElementById("bt-sug");
  el.innerHTML = ""; btSugActive = -1;
  if (!btSugItems.length) { _btHideSug(); return; }
  const q = document.getElementById("bt-ticker").value.trim();
  btSugItems.forEach((it, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span><span class="sym">${_mark(it.symbol, q)}</span> ${_mark(it.name || "", q)}</span>`
                 + `<span class="exch">${_esc(it.exchange || "")} ${_esc(it.type || "")}</span>`;
    li.addEventListener("mouseenter", () => { btSugActive = i; _btHlSug(); });
    li.addEventListener("click", () => _btPickSug(it));
    el.appendChild(li);
  });
  el.classList.add("show");
}
function _btHlSug() { [...document.getElementById("bt-sug").children].forEach((li, i) => li.classList.toggle("active", i === btSugActive)); }
function _btMoveSug(d) { btSugActive = (btSugActive + d + btSugItems.length) % btSugItems.length; _btHlSug(); }
function _btHideSug() { const el = document.getElementById("bt-sug"); if (el) el.classList.remove("show"); btSugItems = []; btSugActive = -1; }
function _btPickSug(it) { document.getElementById("bt-ticker").value = it.symbol; _btHideSug(); }

// --- Python syntax highlighting (overlay technique, no external deps) -------
const _PY_KW = new Set(("def return if elif else for while in and or not is None True False "
  + "import from as with try except finally class lambda pass break continue global nonlocal "
  + "yield raise assert del print range len True False").split(" "));

function _btHighlightPython(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const re = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+\.?\d*\b)|([A-Za-z_]\w*)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    if (m[1]) out += `<span class="tk-com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tk-str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tk-num">${esc(m[3])}</span>`;
    else {
      const w = m[4];
      if (_PY_KW.has(w)) out += `<span class="tk-kw">${w}</span>`;
      else if (/^\s*\(/.test(src.slice(m.index + w.length))) out += `<span class="tk-fn">${w}</span>`;
      else out += esc(w);
    }
    last = re.lastIndex;
  }
  out += esc(src.slice(last));
  return out;
}

function _btSyncHighlight() {
  const ta = document.getElementById("bt-code");
  const hl = document.getElementById("bt-highlight");
  if (!ta || !hl) return;
  let html = _btHighlightPython(ta.value);
  if (ta.value.endsWith("\n")) html += " ";   // keep last line height aligned
  hl.innerHTML = html;
  hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
}

async function _btCopyCode() {
  const ta = document.getElementById("bt-code");
  const btn = document.getElementById("bt-copy");
  try { await navigator.clipboard.writeText(ta.value); }
  catch { ta.select(); document.execCommand("copy"); }
  if (btn) { const t = btn.textContent; btn.textContent = "✓ Copied"; setTimeout(() => (btn.textContent = t), 1200); }
}

let _btEditorHome = null;
function _btExpandEditor() {
  const ed = document.getElementById("bt-editor");
  const modal = document.getElementById("bt-modal");
  if (!ed || !modal) return;
  _btEditorHome = document.createElement("div");
  ed.parentNode.insertBefore(_btEditorHome, ed);          // placeholder to restore position
  document.getElementById("bt-modal-body").appendChild(ed);
  modal.hidden = false;
  _btSyncHighlight();
  document.getElementById("bt-code")?.focus();
}
function _btCloseEditor() {
  const ed = document.getElementById("bt-editor");
  const modal = document.getElementById("bt-modal");
  if (ed && _btEditorHome) { _btEditorHome.parentNode.replaceChild(ed, _btEditorHome); _btEditorHome = null; }
  if (modal) modal.hidden = true;
  _btSyncHighlight();
}

async function runBacktest() {
  const btn = document.getElementById("bt-run");
  const status = document.getElementById("bt-status");
  const body = {
    code: document.getElementById("bt-code").value,
    ticker: document.getElementById("bt-ticker").value,
    start: document.getElementById("bt-start").value,
    end: document.getElementById("bt-end").value,
    cash: document.getElementById("bt-cash").value,
    interval: (document.getElementById("bt-interval") || {}).value || "1d",
  };
  btn.disabled = true;
  status.textContent = "Running backtest in sandbox…";
  let r;
  try {
    r = await (await fetch("/api/backtest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json();
  } catch (e) { r = { ok: false, error: String(e) }; }
  btn.disabled = false;
  renderBacktest(r);
}

function _btPct(x, dp = 1) { return (x >= 0 ? "+" : "") + (x * 100).toFixed(dp) + "%"; }
const _btSign = (x) => (x >= 0 ? "pos" : "neg");

// KPI dashboard row
function _btKpis(m) {
  const card = (lab, val, cls = "", sub = "") =>
    `<div class="btx-kpi"><div class="k-lab">${lab}</div><div class="k-val ${cls}">${val}</div>${sub ? `<div class="k-sub">${sub}</div>` : ""}</div>`;
  const vsBench = m.total_return - m.bench_return;
  return [
    card("Total Return", _btPct(m.total_return), _btSign(m.total_return), `vs B&amp;H ${_btPct(vsBench)}`),
    card("CAGR", _btPct(m.cagr), _btSign(m.cagr)),
    card("Sharpe", m.sharpe.toFixed(2)),
    card("Sortino", m.sortino.toFixed(2)),
    card("Max Drawdown", _btPct(m.max_drawdown), "neg"),
    card("Win Rate", (m.win_rate * 100).toFixed(0) + "%", "", `${m.wins}W / ${m.losses}L`),
    card("Profit Factor", m.profit_factor.toFixed(2)),
    card("Trades", m.num_trades),
    card("Exposure", (m.exposure * 100).toFixed(0) + "%"),
    card("Volatility", (m.volatility * 100).toFixed(1) + "%", "", "annualized"),
  ].join("");
}

// Evenly-spaced date axis labels (HTML row, since the SVG is stretched).
function _btXLabels(rows) {
  const n = rows.length;
  if (!n) return "";
  const k = Math.min(6, n), idxs = [];
  for (let i = 0; i < k; i++) idxs.push(Math.round((i * (n - 1)) / (k - 1)));
  return `<div class="btx-xlabels">` + idxs.map((i) => `<span>${_qLabel(rows[i].date)}</span>`).join("") + `</div>`;
}

// Equity curve (strategy vs benchmark)
function _btEquityChart(curve) {
  if (!curve || curve.length < 2) return `<p class="dash-empty">No data.</p>`;
  const W = 800, H = 320, P = 10;
  const eq = curve.map((c) => c.equity), bn = curve.map((c) => c.bench);
  const lo = Math.min(...eq, ...bn), hi = Math.max(...eq, ...bn), span = (hi - lo) || 1;
  const n = curve.length;
  const X = (i) => P + (i / (n - 1)) * (W - 2 * P);
  const Y = (v) => (H - P) - ((v - lo) / span) * (H - 2 * P);
  const line = (arr) => arr.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  return `<svg class="btx-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline class="bt-line bench" points="${line(bn)}"/>
      <polyline class="bt-line strat" points="${line(eq)}"/>
    </svg>${_btXLabels(curve)}`;
}

// Drawdown underwater area
function _btDrawdownChart(dd) {
  if (!dd || dd.length < 2) return `<p class="dash-empty">—</p>`;
  const W = 400, H = 150, P = 6;
  const vals = dd.map((d) => d.dd);            // negative %, 0 at top
  const lo = Math.min(...vals, -1), n = dd.length;
  const X = (i) => P + (i / (n - 1)) * (W - 2 * P);
  const Y = (v) => P + (v / lo) * (H - 2 * P); // v in [lo,0] → y in [H-P top? ] map 0→P, lo→H-P
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const area = `${X(0).toFixed(1)},${P} ${pts} ${X(n - 1).toFixed(1)},${P}`;
  return `<svg class="btx-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polygon class="bt-dd-area" points="${area}"/>
      <polyline class="bt-dd-line" points="${pts}"/>
    </svg>${_btXLabels(dd)}`;
}

// Monthly returns heatmap
function _btMonthly(monthly) {
  const ms = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const years = Object.keys(monthly || {}).sort();
  if (!years.length) return `<p class="dash-empty">—</p>`;
  const cell = (v) => {
    if (v == null) return `<td class="hm-empty">·</td>`;
    const a = Math.min(1, Math.abs(v) / 10);
    const col = v >= 0 ? `rgba(16,185,129,${0.18 + a * 0.55})` : `rgba(239,68,68,${0.18 + a * 0.55})`;
    return `<td style="background:${col}">${v >= 0 ? "+" : ""}${v.toFixed(1)}</td>`;
  };
  const head = `<tr><th></th>${ms.map((m) => `<th>${m}</th>`).join("")}<th class="hm-ytd">YTD</th></tr>`;
  const rows = years.map((y) => {
    const r = monthly[y] || {};
    return `<tr><th>${y}</th>${ms.map((m) => cell(r[m])).join("")}${cell(r.YTD)}</tr>`;
  }).join("");
  return `<table class="btx-heatmap">${head}${rows}</table>`;
}

// Trade log + stats
function _btTradeLog(trades, stats) {
  const tstats = document.getElementById("bt-tstats");
  if (stats && stats.avg_pct != null) {
    tstats.innerHTML =
      `<span class="ts up">Best ${_btPct(stats.best_pct)}</span>` +
      `<span class="ts down">Worst ${_btPct(stats.worst_pct)}</span>` +
      `<span class="ts">Avg ${_btPct(stats.avg_pct)}</span>` +
      `<span class="ts">Hold ${stats.avg_hold.toFixed(0)}d</span>`;
  } else { tstats.innerHTML = ""; }
  if (!trades || !trades.length) return `<p class="dash-empty">No trades generated.</p>`;
  const rows = trades.slice().reverse().map((t, i) => `<tr>
      <td>${trades.length - i}</td>
      <td>${t.entry_date}</td><td>${t.exit_date}</td>
      <td><span class="t-side ${t.side}">${t.side === "long" ? "BUY" : "SELL"}</span></td>
      <td>$${t.entry_price}</td><td>$${t.exit_price}</td>
      <td class="${t.pnl >= 0 ? "up" : "down"}">${t.pnl >= 0 ? "+" : ""}$${Math.abs(t.pnl).toLocaleString()}</td>
      <td class="${t.pnl_pct >= 0 ? "up" : "down"}">${_btPct(t.pnl_pct)}</td>
      <td>${t.hold_days}d</td></tr>`).join("");
  return `<table class="btx-tradetbl"><thead><tr><th>#</th><th>Entry</th><th>Exit</th><th>Type</th><th>Entry $</th><th>Exit $</th><th>PnL</th><th>PnL %</th><th>Hold</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderBacktest(r) {
  const status = document.getElementById("bt-status");
  const kpis = document.getElementById("bt-kpis");
  const chart = document.getElementById("bt-chart");
  const err = document.getElementById("bt-error");
  const trades = document.getElementById("bt-trades");
  const dd = document.getElementById("bt-dd");
  const monthly = document.getElementById("bt-monthly");
  const legend = document.getElementById("bt-eq-legend");
  if (!r || !r.ok) {
    err.hidden = false;
    err.textContent = (r && r.error ? r.error : "Backtest failed") + (r && r.trace ? "\n\n" + r.trace : "");
    status.textContent = "Error — fix your strategy and re-run.";
    return;
  }
  err.hidden = true; err.textContent = "";
  const m = r.metrics;
  kpis.innerHTML = _btKpis(m);
  chart.innerHTML = _btEquityChart(r.equity_curve);
  dd.innerHTML = _btDrawdownChart(r.drawdown);
  monthly.innerHTML = _btMonthly(r.monthly);
  trades.innerHTML = _btTradeLog(r.trades, r.trade_stats);
  const ec = r.equity_curve || [];
  if (legend && ec.length) {
    const fe = ec[ec.length - 1];
    legend.innerHTML = `<span><i></i>Strategy $${Number(fe.equity).toLocaleString()} (${_btPct(m.total_return)})</span>`
      + `<span><i class="bench"></i>Buy &amp; Hold $${Number(fe.bench).toLocaleString()} (${_btPct(m.bench_return)})</span>`;
  }
  const barLabel = r.interval === "1h" ? "hourly bars" : "daily bars";
  status.textContent = `${r.ticker} · ${r.start} → ${r.end} · ${barLabel}`;
}

// --------------------------------------------------------------------------- //
// Portfolio — Alpaca paper trading
// --------------------------------------------------------------------------- //
let _pfRange = "1M", _pfSide = "buy", _pfEquity = 0;
const _usd = (n) => "$" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const _pfSign = (x) => (x >= 0 ? "pos" : "neg");

function initPortfolio() {
  document.getElementById("pf-refresh")?.addEventListener("click", loadPortfolio);
  document.getElementById("pf-submit")?.addEventListener("click", submitPaperOrder);
  document.getElementById("pf-type")?.addEventListener("change", (e) => {
    document.getElementById("pf-limit").hidden = e.target.value !== "limit";
  });
  document.getElementById("pf-buy")?.addEventListener("click", () => _setPfSide("buy"));
  document.getElementById("pf-sell")?.addEventListener("click", () => _setPfSide("sell"));
  const symEl = document.getElementById("pf-sym"), symSug = document.getElementById("pf-sug");
  if (symEl && symSug) attachTickerSuggest(symEl, symSug);
  document.getElementById("pf-range")?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-r]"); if (!b) return;
    _pfRange = b.dataset.r;
    document.querySelectorAll("#pf-range button").forEach((x) => x.classList.toggle("active", x === b));
    loadPfHistory();
  });
  loadPortfolio();
}

function _setPfSide(s) {
  _pfSide = s;
  document.getElementById("pf-buy")?.classList.toggle("active", s === "buy");
  document.getElementById("pf-sell")?.classList.toggle("active", s === "sell");
}

async function loadPortfolio() {
  const notice = document.getElementById("pf-notice");
  const kpis = document.getElementById("pf-kpis");
  const mains = document.querySelectorAll("#page-portfolio .pf-main");
  let a;
  try { a = await (await fetch("/api/portfolio/account")).json(); }
  catch (e) { a = { connected: false, error: String(e) }; }

  if (!a.connected) {
    notice.hidden = false;
    notice.innerHTML = `<b>Connect Alpaca paper trading.</b> ${_esc(a.error || "")}<br>
      Add <code>ALPACA_API_KEY</code> and <code>ALPACA_SECRET_KEY</code> to your <code>.env</code>
      (free paper keys at <a href="https://alpaca.markets" target="_blank" rel="noopener">alpaca.markets</a> → Paper Trading → API Keys), then restart the server.`;
    kpis.innerHTML = ""; mains.forEach((m) => (m.style.display = "none"));
    return;
  }
  notice.hidden = true; mains.forEach((m) => (m.style.display = ""));
  _pfEquity = a.equity || 0;
  const card = (lab, val, cls = "", sub = "") =>
    `<div class="btx-kpi"><div class="k-lab">${lab}</div><div class="k-val ${cls}">${val}</div>${sub ? `<div class="k-sub">${sub}</div>` : ""}</div>`;
  kpis.innerHTML =
    card("Stock", _usd(a.long_market_value || 0), "", "holdings value") +
    card("Cash", _usd(a.cash), "", "available to trade") +
    card("Buying Power", _usd(a.buying_power), "", "cash + margin") +
    card("Day P&amp;L", (a.day_pl >= 0 ? "+" : "") + _usd(a.day_pl), _pfSign(a.day_pl), _btPct(a.day_pl_pct, 2)) +
    card("Total P&amp;L", a.total_pl != null ? (a.total_pl >= 0 ? "+" : "") + _usd(a.total_pl) : "—", a.total_pl >= 0 ? "pos" : "neg", a.total_return != null ? _btPct(a.total_return) : "") +
    card("Total Return", a.total_return != null ? _btPct(a.total_return) : "—", a.total_return >= 0 ? "pos" : "neg", "all time");

  loadPositions();
  loadPfOrders();
  loadPfHistory();
}

async function loadPfHistory() {
  const chart = document.getElementById("pf-chart");
  const sum = document.getElementById("pf-perf-sum");
  const val = document.getElementById("pf-perf-val");
  let h;
  try { h = await (await fetch(`/api/portfolio/history?range=${_pfRange}`)).json(); }
  catch { chart.innerHTML = `<p class="dash-empty">Could not load history.</p>`; return; }
  if (!h.connected || !(h.points || []).length) {
    chart.innerHTML = `<p class="dash-empty">No history for this range.</p>`; sum.innerHTML = ""; return;
  }
  const last = h.points[h.points.length - 1].equity;
  val.innerHTML = `${_usd(last)} <span class="${_pfSign(h.range_return)}">${_btPct(h.range_return)}</span> <span class="pf-range-lab">${_pfRange}</span>`;
  chart.innerHTML = _pfEquityChart(h.points, h.base_value, h.intraday);
  _pfWireHover();
  // Signed by the REAL value (don't force +/-), so a single-day range can't read
  // as both +$X and -$X. Best/Worst are only distinct stats with ≥2 days.
  const signed = (v) => `${(v || 0) >= 0 ? "+" : "-"}${_usd(Math.abs(v || 0))}`;
  const multiDay = (h.total_days || 0) >= 2;
  sum.innerHTML =
    `<div class="pf-sumcell"><div class="ps-lab">Best Day</div><div class="ps-val ${_pfSign(h.best_day)}">${signed(h.best_day)}</div><div class="ps-sub">${h.best_day_date || "—"}</div></div>`
  + (multiDay
      ? `<div class="pf-sumcell"><div class="ps-lab">Worst Day</div><div class="ps-val ${_pfSign(h.worst_day)}">${signed(h.worst_day)}</div><div class="ps-sub">${h.worst_day_date || "—"}</div></div>`
      : `<div class="pf-sumcell"><div class="ps-lab">Day P&amp;L</div><div class="ps-val ${_pfSign(h.best_day)}">${signed(h.best_day)}</div><div class="ps-sub">single day</div></div>`)
  + `<div class="pf-sumcell"><div class="ps-lab">Win Rate (Days)</div><div class="ps-val">${((h.win_rate || 0) * 100).toFixed(0)}%</div><div class="ps-sub">${h.win_days || 0}/${h.total_days || 0} days</div></div>`;
}

function _pfDateLabel(t) {
  const d = new Date(String(t).replace(" ", "T"));
  if (isNaN(d)) return t;
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${m} ${d.getDate()}`;
}

function _usdK(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return "$" + Number(v).toFixed(0);
}

function _pfSignedK(v) { return (v > 0 ? "+" : v < 0 ? "-" : "") + _usdK(Math.abs(v)); }

let _pfChartState = null;
function _pfEquityChart(points, base, intraday) {
  if (!points || points.length < 2) return `<p class="dash-empty">No history.</p>`;
  const W = 800, H = 300, P = 10, n = points.length;
  const b = base != null ? base : (points[0].equity || 0);
  const vals = points.map((p) => p.equity - b);     // return ($) from the starting value
  // Domain includes 0 so positive return draws above the zero line, negative below.
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.08 || Math.max(1, Math.abs(b) * 0.0005);
  lo -= pad; hi += pad;
  const span = (hi - lo) || 1;
  const X = (i) => P + (i / (n - 1)) * (W - 2 * P);
  const Y = (v) => (H - P) - ((v - lo) / span) * (H - 2 * P);
  const zeroY = Y(0);
  const line = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const area = `${X(0).toFixed(1)},${zeroY.toFixed(1)} ${line} ${X(n - 1).toFixed(1)},${zeroY.toFixed(1)}`;
  const cls = vals[vals.length - 1] >= 0 ? "up" : "down";
  const k = Math.min(6, n), idxs = [];
  for (let i = 0; i < k; i++) idxs.push(Math.round((i * (n - 1)) / (k - 1)));
  const labels = `<div class="btx-xlabels">` + idxs.map((i) => `<span>${_pfDateLabel(points[i].t)}</span>`).join("") + `</div>`;
  // y-axis ticks (5 evenly spaced, signed return), zero highlighted
  const yt = [0, 1, 2, 3, 4].map((j) => {
    const v = hi - (j * span) / 4;
    return `<span class="${Math.abs(v) < span * 0.06 ? "zero" : ""}">${_pfSignedK(v)}</span>`;
  }).join("");
  _pfChartState = { points, b, vals, lo, hi, span, W, H, P, n, intraday: !!intraday };
  return `<div class="pf-plot">
      <div class="pf-yaxis">${yt}</div>
      <div class="pf-main-col">
        <div class="pf-svgwrap" id="pf-svgwrap">
          <svg class="btx-svg pf-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
            <line class="pf-zero" x1="${P}" y1="${zeroY.toFixed(1)}" x2="${W - P}" y2="${zeroY.toFixed(1)}"/>
            <polygon class="pf-area ${cls}" points="${area}"/>
            <polyline class="pf-eqline ${cls}" points="${line}"/>
          </svg>
          <div class="pf-hover" id="pf-hover" hidden><span class="pf-hover-dot"></span></div>
          <div class="pf-tip" id="pf-tip" hidden></div>
        </div>${labels}
      </div>
    </div>`;
}

// Hover the equity curve to read the value/return at each point.
function _pfWireHover() {
  const wrap = document.getElementById("pf-svgwrap");
  const hov = document.getElementById("pf-hover");
  const tip = document.getElementById("pf-tip");
  const st = _pfChartState;
  if (!wrap || !hov || !tip || !st) return;
  const dot = hov.querySelector(".pf-hover-dot");
  const move = (e) => {
    const rect = wrap.getBoundingClientRect();
    if (!rect.width) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const i = Math.round(frac * (st.n - 1));
    const p = st.points[i], v = st.vals[i];
    const ret = st.b ? v / st.b : 0;
    const xPct = (st.P + (i / (st.n - 1)) * (st.W - 2 * st.P)) / st.W * 100;
    const yv = (st.H - st.P) - ((v - st.lo) / st.span) * (st.H - 2 * st.P);
    const yPct = (yv / st.H) * 100;
    hov.hidden = false; hov.style.left = xPct + "%";
    dot.style.top = yPct + "%";
    const dlab = st.intraday ? p.t.slice(5).replace("-", "/") : _pfDateLabel(p.t);
    tip.hidden = false;
    tip.innerHTML = `<div class="pf-tip-d">${dlab}</div>`
      + `<div class="pf-tip-v">${_usd(p.equity)}</div>`
      + `<div class="pf-tip-r ${ret >= 0 ? "pos" : "neg"}">${(ret >= 0 ? "+" : "") + (ret * 100).toFixed(2)}% · ${(v >= 0 ? "+" : "-") + _usd(Math.abs(v))}</div>`;
    // Clamp the tooltip inside the plot (it's ~120px wide).
    tip.style.left = Math.max(0, Math.min(rect.width - 124, frac * rect.width - 62)) + "px";
  };
  wrap.addEventListener("mousemove", move);
  wrap.addEventListener("mouseleave", () => { hov.hidden = true; tip.hidden = true; });
}

// Generic ticker autosuggest: attach to an <input> + <ul.suggestions>.
function attachTickerSuggest(input, sug, onPick) {
  let items = [], active = -1, lastQ = "";
  const hl = () => [...sug.children].forEach((li, i) => li.classList.toggle("active", i === active));
  const hide = () => { sug.classList.remove("show"); items = []; active = -1; };
  const pick = (it) => { input.value = it.symbol; hide(); if (onPick) onPick(it); };
  const render = () => {
    sug.innerHTML = ""; active = -1;
    if (!items.length) { hide(); return; }
    const q = input.value.trim();
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span><span class="sym">${_mark(it.symbol, q)}</span> ${_mark(it.name || "", q)}</span>`
                   + `<span class="exch">${_esc(it.exchange || "")} ${_esc(it.type || "")}</span>`;
      li.addEventListener("mouseenter", () => { active = i; hl(); });
      li.addEventListener("click", () => pick(it));
      sug.appendChild(li);
    });
    sug.classList.add("show");
  };
  const run = async (q) => {
    lastQ = q; items = localRank(q); render();
    try {
      const remote = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
      if (q !== lastQ) return;
      items = _mergeItems(items, remote); render();
    } catch { /* keep local */ }
  };
  input.addEventListener("input", () => { const q = input.value.trim(); if (!q) { hide(); return; } run(q); });
  input.addEventListener("keydown", (e) => {
    if (!sug.classList.contains("show")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1 + items.length) % items.length; hl(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; hl(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active]); }
    else if (e.key === "Escape") hide();
  });
  document.addEventListener("click", (e) => { if (!input.contains(e.target) && !sug.contains(e.target)) hide(); });
}

async function loadPositions() {
  const box = document.getElementById("pf-positions");
  const alloc = document.getElementById("pf-alloc");
  let d;
  try { d = await (await fetch("/api/portfolio/positions")).json(); }
  catch { box.innerHTML = `<p class="dash-empty">Could not load positions.</p>`; return; }
  const ps = d.positions || [];
  const eq = _pfEquity || ps.reduce((s, p) => s + p.market_value, 0) || 1;
  if (!ps.length) { box.innerHTML = `<p class="dash-empty">No open positions.</p>`; }
  else {
    box.innerHTML = `<table class="kv-table"><thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Last</th><th>Value</th><th>P&amp;L</th><th>Alloc</th></tr></thead><tbody>` +
      ps.map((p) => `<tr><td class="kv-metric">${_esc(p.symbol)}</td><td>${p.qty}</td><td>${_usd(p.avg_entry)}</td><td>${_usd(p.current_price)}</td><td>${_usd(p.market_value)}</td>
        <td class="${p.unrealized_pl >= 0 ? "up" : "down"}">${(p.unrealized_pl >= 0 ? "+" : "") + _usd(p.unrealized_pl)} (${(p.unrealized_plpc * 100).toFixed(1)}%)</td>
        <td>${(p.market_value / eq * 100).toFixed(1)}%</td></tr>`).join("") +
      `</tbody></table>`;
  }
  // allocation donut: positions + cash
  const invested = ps.reduce((s, p) => s + p.market_value, 0);
  const cash = Math.max(0, eq - invested);
  const slices = ps.map((p) => ({ label: p.symbol, value: p.market_value })).concat([{ label: "CASH", value: cash }]);
  alloc.innerHTML = _pfDonut(slices);
}

function _pfDonut(slices) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const R = 42, C = 2 * Math.PI * R, cx = 50, cy = 50;
  const colors = ["#3b82f6", "#10b981", "#a855f7", "#f59e0b", "#ef4444", "#14b8a6", "#eab308", "#6b7689"];
  let off = 0;
  const segs = slices.map((s, i) => {
    const len = (s.value / total) * C;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="12" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += len; return seg;
  }).join("");
  const legend = slices.map((s, i) =>
    `<div class="pf-leg"><span class="dot" style="background:${colors[i % colors.length]}"></span><span class="pf-leg-sym">${_esc(s.label)}</span><span class="pf-leg-pct">${(s.value / total * 100).toFixed(1)}%</span></div>`).join("");
  return `<div class="pf-donut-wrap"><svg viewBox="0 0 100 100" class="pf-donut">${segs}</svg><div class="pf-legend">${legend}</div></div>`;
}

async function loadPfOrders() {
  const box = document.getElementById("pf-orders");
  let d;
  try { d = await (await fetch("/api/portfolio/orders?limit=15")).json(); }
  catch { box.innerHTML = `<p class="dash-empty">Could not load orders.</p>`; return; }
  const os = d.orders || [];
  if (!os.length) { box.innerHTML = `<p class="dash-empty">No orders yet.</p>`; return; }
  box.innerHTML = os.map((o) => `<div class="pf-order-row"><span class="t-side ${o.side}">${o.side.toUpperCase()}</span>
      <span class="kv-metric">${_esc(o.symbol)}</span><span class="pf-ord-meta">${o.qty ?? ""} sh · ${_esc(o.type)} · ${_esc(o.status)}</span>
      <span class="t-price">${o.filled_avg_price ? _usd(o.filled_avg_price) : ""}</span></div>`).join("");
}

async function submitPaperOrder() {
  const btn = document.getElementById("pf-submit");
  const msg = document.getElementById("pf-order-msg");
  const body = {
    symbol: document.getElementById("pf-sym").value,
    qty: document.getElementById("pf-qty").value,
    side: _pfSide,
    type: document.getElementById("pf-type").value,
    limit_price: document.getElementById("pf-limit").value || null,
  };
  btn.disabled = true; msg.textContent = "Submitting…"; msg.className = "pf-msg";
  let r;
  try { r = await (await fetch("/api/portfolio/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(); }
  catch (e) { r = { ok: false, error: String(e) }; }
  btn.disabled = false;
  if (r.ok) {
    msg.textContent = `✓ ${r.side.toUpperCase()} ${r.qty} ${r.symbol} — ${r.status}`;
    msg.className = "pf-msg ok";
    loadPortfolio();
  } else {
    msg.textContent = `⚠️ ${r.error || "Order failed"}`;
    msg.className = "pf-msg err";
  }
}

// --------------------------------------------------------------------------- //
// Invitation-code gate
//
// Two static codes (validated server-side): "trade buddy" → guest (must supply
// their own DeepSeek/Alpaca keys) and "trade buddy is good" → invited (uses the
// owner's keys). The session is an encrypted cookie, so once authed every API
// call — including the SSE streams — is allowed automatically.
// --------------------------------------------------------------------------- //
let _authTier = null;

const _gateEl     = () => document.getElementById("auth-gate");
const _codeForm   = () => document.getElementById("auth-code-form");
const _keysForm   = () => document.getElementById("auth-keys-form");

function showAuthGate(panel) {
  _gateEl().hidden = false;
  const code = _codeForm(), keys = _keysForm();
  if (panel === "keys") { code.hidden = true; keys.hidden = false; document.getElementById("auth-ds").focus(); }
  else { code.hidden = false; keys.hidden = true; document.getElementById("auth-code").focus(); }
}
function hideAuthGate() { _gateEl().hidden = true; }

function _renderAcct(me) {
  _authTier = me.tier;
  const badge = document.getElementById("acct-tier");
  if (badge) {
    badge.textContent = me.tier === "invited" ? "Invited" : "Guest";
    badge.className = "acct-tier " + me.tier;
  }
  const keysBtn = document.getElementById("acct-keys");
  if (keysBtn) keysBtn.hidden = (me.tier !== "guest");   // only guests manage keys
}

// Authed → drop the gate and run the gated boot exactly once.
function enterApp(me) {
  _renderAcct(me);
  hideAuthGate();
  bootApp();
}

async function initAuth() {
  let me;
  try { me = await (await fetch("/api/auth/me")).json(); }
  catch { me = { authed: false }; }
  if (me && me.authed) enterApp(me);
  else showAuthGate("code");
}

// Step 1 — submit the invitation code.
document.getElementById("auth-code-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("auth-code");
  const err = document.getElementById("auth-code-err");
  const btn = e.target.querySelector("button[type=submit]");
  err.textContent = ""; btn.disabled = true;
  let r;
  try { r = await (await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: input.value }),
  })).json(); } catch { r = { error: "network" }; }
  btn.disabled = false;
  if (r.error || !r.authed) { err.textContent = "That code isn't valid. Check it and try again."; input.select(); return; }
  _renderAcct(r);
  if (r.tier === "guest") showAuthGate("keys");   // guest must add their own keys
  else enterApp(r);                               // invited uses the owner's keys
});

// Step 2 — guest saves their own keys (or skips).
document.getElementById("auth-keys-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("auth-keys-err");
  const btn = e.target.querySelector("button[type=submit]");
  const body = {
    deepseek: document.getElementById("auth-ds").value.trim(),
    alpaca_key: document.getElementById("auth-ak").value.trim(),
    alpaca_secret: document.getElementById("auth-as").value.trim(),
  };
  err.textContent = ""; btn.disabled = true;
  let r;
  try { r = await (await fetch("/api/auth/keys", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json(); } catch { r = { error: "network" }; }
  btn.disabled = false;
  if (r.error || !r.authed) { err.textContent = "Couldn't save those keys. Try again."; return; }
  // Clear the inputs from the DOM once stored in the cookie.
  ["auth-ds", "auth-ak", "auth-as"].forEach((id) => { document.getElementById(id).value = ""; });
  enterApp(r);
});

document.getElementById("auth-skip")?.addEventListener("click", () => {
  enterApp({ authed: true, tier: "guest" });   // in, but key-gated features will prompt
});
document.getElementById("auth-keys-close")?.addEventListener("click", () => hideAuthGate());

// Sidebar: re-open the key form (guests) / sign out.
document.getElementById("acct-keys")?.addEventListener("click", () => {
  document.getElementById("auth-skip").hidden = true;        // already in — offer Close, not Skip
  document.getElementById("auth-keys-close").hidden = false;
  showAuthGate("keys");
});
document.getElementById("acct-logout")?.addEventListener("click", async () => {
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
  location.reload();
});

// --------------------------------------------------------------------------- //
// Export — each analyst report / the debate / the verdict / everything,
// as Markdown (.md) or a well-formatted PDF (browser print engine → selectable
// text), with a live preview.
// --------------------------------------------------------------------------- //
function _mdCell(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim(); }

function _reportMd(agent) {
  const r = reports.get(agent); if (!r) return "";
  return `# ${agent}\n\n${r.summary ? `*${r.summary}*\n\n` : ""}${r.content || ""}\n`;
}

function _debateMd() {
  if (!_exportDebate.length && !_exportConsensus) return "";
  let md = `# Bull vs. Bear Debate\n\n`;
  _exportDebate.forEach((t) => {
    md += `## ${t.side === "bull" ? "🐂 Bull" : "🐻 Bear"} — Round ${t.round}/${t.rounds}\n\n`;
    if (t.summary) md += `*${t.summary}*\n\n`;
    md += `${t.content}\n\n`;
  });
  if (_exportConsensus) {
    md += `## ${_exportConsensus.reached ? "Consensus reached ✓" : "No consensus — Judge decides"}\n\n${_exportConsensus.content}\n`;
  }
  return md;
}

function _verdictMd() {
  if (!_exportVerdict) return "";
  const v = _exportVerdict;
  let md = `# Judge Verdict${v.ticker ? " — " + v.ticker : ""}\n\n`;
  md += `**Decision:** ${v.rating || v.decision || "—"}`;
  if (typeof v.weighted_score === "number") {
    md += `  ·  **Weighted score:** ${v.weighted_score >= 0 ? "+" : ""}${v.weighted_score.toFixed(2)} (−1 bearish … +1 bullish)`;
  }
  md += `\n\n`;
  if (v.scoreboard && v.scoreboard.length) {
    md += `## Scoreboard\n\n| Metric | Source | Score | Weight | Detail |\n|---|---|---:|---:|---|\n`;
    v.scoreboard.forEach((e) => {
      const sc = +e.score || 0;
      const detail = e.raw_value != null && e.raw_value !== "" ? e.raw_value : (e.note || "");
      md += `| ${_mdCell(e.metric)} | ${_mdCell(e.source)} | ${sc >= 0 ? "+" : ""}${sc.toFixed(2)} | ${(+e.weight || 0).toFixed(2)} | ${_mdCell(detail)} |\n`;
    });
    md += `\n`;
  }
  if (v.verdict_md) md += `## Full verdict\n\n${v.verdict_md}\n`;
  return md;
}

function _everythingMd() {
  const t = (_exportVerdict && _exportVerdict.ticker) || currentTicker || "";
  const date = new Date().toISOString().slice(0, 10);
  let md = `# Trade Buddy — Full Analysis${t ? ": " + t : ""}\n\n_Generated ${date}_\n\n`;
  if (reports.size) {
    md += `---\n\n# Analyst Reports\n\n`;
    reports.forEach((_, agent) => { md += _reportMd(agent) + `\n---\n\n`; });
  }
  const d = _debateMd(); if (d) md += d + `\n---\n\n`;
  const v = _verdictMd(); if (v) md += v + `\n`;
  return md;
}

function _exportSections() {
  const opts = [];
  reports.forEach((_, agent) => opts.push({ v: "report:" + agent, label: agent }));
  if (_exportDebate.length) opts.push({ v: "debate", label: "Bull vs. Bear Debate" });
  if (_exportVerdict) opts.push({ v: "verdict", label: "Judge Verdict" });
  if (reports.size || _exportDebate.length || _exportVerdict) opts.push({ v: "all", label: "★ Everything (full report)" });
  return opts;
}

function _exportMdFor(v) {
  if (v === "all") return _everythingMd();
  if (v === "debate") return _debateMd();
  if (v === "verdict") return _verdictMd();
  if (v && v.startsWith("report:")) return _reportMd(v.slice(7));
  return "";
}

function _exportNameFor(v) {
  const t = ((_exportVerdict && _exportVerdict.ticker) || currentTicker || "report").replace(/[^\w.-]+/g, "");
  if (v === "all") return `TradeBuddy_${t}_full`;
  if (v === "debate") return `TradeBuddy_${t}_debate`;
  if (v === "verdict") return `TradeBuddy_${t}_verdict`;
  if (v && v.startsWith("report:")) return `TradeBuddy_${t}_${v.slice(7).replace(/[^\w.-]+/g, "_")}`;
  return `TradeBuddy_${t}`;
}

function _exportChecked() {
  return Array.from(document.querySelectorAll("#export-pick input:checked")).map((i) => i.value);
}

function _combinedMdFor(vals) {
  return vals.map((v) => _exportMdFor(v)).filter(Boolean).join("\n\n---\n\n");
}

function _exportTicker() {
  return ((_exportVerdict && _exportVerdict.ticker) || currentTicker || "report").replace(/[^\w.-]+/g, "");
}

// One section selected → single .md / PDF. Two or more → reveal the .zip action
// (each section becomes its own file in the archive).
function _syncExportButtons() {
  const n = _exportChecked().length;
  document.getElementById("export-zip").hidden = n < 2;
  document.getElementById("export-md").disabled = n === 0;
  document.getElementById("export-pdf").disabled = n === 0;
}

function openExportModal() {
  const opts = _exportSections();
  if (!opts.length) { setStatus("nothing to export yet — run an analysis"); return; }
  const pick = document.getElementById("export-pick");
  // Default-check whatever tab the reading window is on.
  const tab = document.querySelector("#coord-read-tabs button.active")?.dataset.rtab;
  let def = "all";
  if (tab === "debate" && _exportDebate.length) def = "debate";
  else if (tab === "verdict" && _exportVerdict) def = "verdict";
  else if (tab === "reports" && activeReport && reports.has(activeReport)) def = "report:" + activeReport;
  pick.innerHTML = opts.map((o) =>
    `<label><input type="checkbox" value="${o.v}"${o.v === def ? " checked" : ""}/> <span>${_esc(o.label)}</span></label>`
  ).join("");
  pick.querySelectorAll("input").forEach((i) =>
    i.addEventListener("change", () => { _renderExportPreview(); _syncExportButtons(); }));
  _syncExportButtons();
  _renderExportPreview();
  if (window.__applyLang) window.__applyLang();   // localize the freshly-built labels
  document.getElementById("export-modal").hidden = false;
}

function _renderExportPreview() {
  const md = _combinedMdFor(_exportChecked());
  const box = document.getElementById("export-preview");
  box.innerHTML = md
    ? (window.marked ? marked.parse(md) : _esc(md))
    : `<p class="report-empty">Tick a section to preview it.</p>`;
}

function _download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const PDF_CSS = `
@page { margin: 18mm 16mm; }
* { box-sizing: border-box; }
body { font: 13px/1.65 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:#1a1a1a; margin:0; }
.pdf-doc { max-width: 740px; margin: 0 auto; }
.pdf-brand { font-weight: 800; letter-spacing:.03em; color:#1f6feb; border-bottom:2px solid #1f6feb; padding-bottom:6px; margin-bottom:18px; font-size:15px; }
h1 { font-size:22px; margin:22px 0 10px; }
h2 { font-size:17px; margin:20px 0 8px; border-bottom:1px solid #e3e3e3; padding-bottom:4px; }
h3 { font-size:14px; margin:16px 0 6px; }
p,li { font-size:13px; }
table { border-collapse:collapse; width:100%; margin:10px 0; font-size:12px; }
th,td { border:1px solid #ccc; padding:6px 8px; text-align:left; vertical-align:top; }
th { background:#f3f4f6; }
code { background:#f3f4f6; padding:1px 4px; border-radius:4px; font-size:12px; }
pre { background:#f6f8fa; padding:12px; border-radius:8px; overflow:auto; }
blockquote { border-left:3px solid #d0d7de; margin:8px 0; padding:2px 12px; color:#555; }
hr { border:none; border-top:1px solid #e3e3e3; margin:18px 0; }
h1,h2,h3 { page-break-after: avoid; }
table,pre,blockquote { page-break-inside: avoid; }
`;

function _downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function _exportPdfMd(md, title) {
  if (!md) return;
  const html = window.marked ? marked.parse(md) : _esc(md);
  const w = window.open("", "_blank");
  if (!w) { setStatus("allow pop-ups to export a PDF"); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${_esc(title)}</title>`
    + `<style>${PDF_CSS}</style></head><body><div class="pdf-doc">`
    + `<div class="pdf-brand">Trade Buddy — Your Faithful Trading Companion</div>${html}</div></body></html>`);
  w.document.close(); w.focus();
  // Let layout settle, then open the print dialog → "Save as PDF".
  setTimeout(() => { try { w.print(); } catch {} }, 400);
}

function _exportPdf(v) {
  _exportPdfMd(_exportMdFor(v), _exportNameFor(v));
}

document.getElementById("coord-export")?.addEventListener("click", openExportModal);
document.getElementById("export-close")?.addEventListener("click", () => { document.getElementById("export-modal").hidden = true; });
document.getElementById("export-modal")?.addEventListener("click", (e) => { if (e.target.id === "export-modal") e.currentTarget.hidden = true; });
document.getElementById("export-md")?.addEventListener("click", () => {
  const vals = _exportChecked(); if (!vals.length) { setStatus("nothing selected"); return; }
  const md = _combinedMdFor(vals); if (!md) { setStatus("nothing to export"); return; }
  const name = vals.length === 1 ? _exportNameFor(vals[0]) : `TradeBuddy_${_exportTicker()}_sections`;
  _download(name + ".md", md, "text/markdown;charset=utf-8");
});
document.getElementById("export-pdf")?.addEventListener("click", () => {
  const vals = _exportChecked(); if (!vals.length) { setStatus("nothing selected"); return; }
  if (vals.length === 1) { _exportPdf(vals[0]); return; }
  _exportPdfMd(_combinedMdFor(vals), `TradeBuddy_${_exportTicker()}_sections`);
});
document.getElementById("export-zip")?.addEventListener("click", async () => {
  const vals = _exportChecked(); if (vals.length < 2) return;
  const files = vals
    .map((v) => ({ name: _exportNameFor(v) + ".md", content: _exportMdFor(v) }))
    .filter((f) => f.content);
  if (!files.length) { setStatus("nothing to export"); return; }
  try {
    const res = await fetch("/api/export/zip", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `TradeBuddy_${_exportTicker()}_reports`, files }),
    });
    if (!res.ok) throw new Error("zip failed");
    _downloadBlob(`TradeBuddy_${_exportTicker()}_reports.zip`, await res.blob());
  } catch (e) { console.error(e); setStatus("zip export failed"); }
});

// --------------------------------------------------------------------------- //
// Appearance (dark/light theme) + UI internationalisation
// --------------------------------------------------------------------------- //
// The theme is a single data-theme attribute on <html> driving the CSS vars.
// i18n works by walking the static chrome and swapping any text/placeholder/title
// that matches the dictionary below — dynamic, data-bearing regions (agent
// output, chat, news, the chart) are skipped because their language is governed
// by the per-run output language, not the UI. Unknown strings fall back to
// English gracefully, so the dictionary can be grown incrementally.

const I18N = {
  "Simplified Chinese": {
    "Trading Portal": "交易门户",
    "Your Faithful Trading Companion": "您忠实的交易伙伴",
    "Dashboard": "仪表盘", "Agent Coordination": "智能体协作", "Watchlist": "自选列表",
    "Markets": "市场", "Screener": "选股器", "News": "新闻", "Smart Money": "聪明钱",
    "AI Analysis": "AI 分析", "Backtester": "回测", "Alerts": "提醒", "Portfolio": "投资组合",
    "Settings": "设置", "Market Status": "市场状态", "US Market opens in": "美股距开盘",
    "HRS": "时", "MIN": "分", "SEC": "秒", "API keys": "API 密钥", "Sign out": "退出登录",
    "Exchange": "交易所", "Search stocks, indices, news…": "搜索股票、指数、新闻…",
    "pick a ticker": "请选择标的", "▸ Run agents": "▸ 运行智能体",
    "Pick a ticker to begin": "请选择一个标的开始",
    "Open": "开盘", "High": "最高", "Low": "最低", "Prev Close": "昨收",
    "Volume": "成交量", "Market Cap": "市值",
    "Pick a ticker to load the interactive chart…": "请选择标的以加载交互图表…",
    "Overview": "概览", "Fundamentals": "基本面", "Financials": "财务", "Technicals": "技术面",
    "Company overview": "公司概览", "Run agent analysis →": "运行智能体分析 →",
    "Pick a ticker to load the company overview…": "请选择标的以加载公司概览…",
    "Select a ticker to load fundamentals.": "请选择标的以加载基本面。",
    "Pick a ticker to load financials…": "请选择标的以加载财务数据…",
    "Loading technicals…": "正在加载技术指标…",
    "Add a ticker with the ☆ to track it here.": "用 ☆ 添加标的以在此跟踪。",
    "Quick Overview": "快速概览", "Change (1D)": "涨跌（1日）", "Change (5D)": "涨跌（5日）",
    "Change (1M)": "涨跌（1月）", "52W High": "52周最高", "52W Low": "52周最低",
    "P/E Ratio": "市盈率", "Day's Range": "当日区间", "Key Signals": "关键信号",
    "Pick a ticker to compute signals…": "请选择标的以计算信号…",
    "Latest News": "最新新闻", "Pick a ticker for news…": "请选择标的以查看新闻…",
    "Invitation code": "邀请码", "Enter your invitation code": "请输入您的邀请码",
    "Enter": "进入", "Save & continue": "保存并继续", "Skip for now": "暂时跳过", "Close": "关闭",
    "DeepSeek API key": "DeepSeek API 密钥", "required to analyze / chat": "分析/聊天必填",
    "Alpaca key": "Alpaca 密钥", "optional · paper · for Portfolio": "可选 · 模拟盘 · 用于投资组合",
    "Alpaca secret": "Alpaca 私钥",
    "Appearance": "外观", "Choose a dark or light interface theme.": "选择深色或浅色界面主题。",
    "Dark": "深色", "Light": "浅色", "Language": "语言",
    "Language of the interface and, by default, agent reports.": "界面语言，并默认作为智能体报告语言。",
    "Export report": "导出报告",
    "Tick the sections to export. One = .md or PDF; several = a .zip.": "勾选要导出的部分。单个为 .md 或 PDF；多个为 .zip。",
    "Markdown (.md)": "Markdown (.md)", "PDF": "PDF", "ZIP (.zip)": "ZIP (.zip)",
    "Bull vs. Bear Debate": "多空辩论", "Judge Verdict": "裁判结论",
    "★ Everything (full report)": "★ 全部（完整报告）",
    "Provider": "提供方", "Debate depth": "辩论深度", "Shallow": "浅", "Medium": "中", "Deep": "深",
    "Collectors": "数据收集", "Technical": "技术面",
  },
  "Traditional Chinese": {
    "Trading Portal": "交易門戶",
    "Your Faithful Trading Companion": "您忠實的交易夥伴",
    "Dashboard": "儀表板", "Agent Coordination": "智能體協作", "Watchlist": "自選清單",
    "Markets": "市場", "Screener": "選股器", "News": "新聞", "Smart Money": "聰明錢",
    "AI Analysis": "AI 分析", "Backtester": "回測", "Alerts": "提醒", "Portfolio": "投資組合",
    "Settings": "設定", "Market Status": "市場狀態", "US Market opens in": "美股距開盤",
    "HRS": "時", "MIN": "分", "SEC": "秒", "API keys": "API 金鑰", "Sign out": "登出",
    "Exchange": "交易所", "Search stocks, indices, news…": "搜尋股票、指數、新聞…",
    "pick a ticker": "請選擇標的", "▸ Run agents": "▸ 執行智能體",
    "Pick a ticker to begin": "請選擇一個標的開始",
    "Open": "開盤", "High": "最高", "Low": "最低", "Prev Close": "昨收",
    "Volume": "成交量", "Market Cap": "市值",
    "Pick a ticker to load the interactive chart…": "請選擇標的以載入互動圖表…",
    "Overview": "概覽", "Fundamentals": "基本面", "Financials": "財務", "Technicals": "技術面",
    "Company overview": "公司概覽", "Run agent analysis →": "執行智能體分析 →",
    "Pick a ticker to load the company overview…": "請選擇標的以載入公司概覽…",
    "Select a ticker to load fundamentals.": "請選擇標的以載入基本面。",
    "Pick a ticker to load financials…": "請選擇標的以載入財務資料…",
    "Loading technicals…": "正在載入技術指標…",
    "Add a ticker with the ☆ to track it here.": "用 ☆ 新增標的以在此追蹤。",
    "Quick Overview": "快速概覽", "Change (1D)": "漲跌（1日）", "Change (5D)": "漲跌（5日）",
    "Change (1M)": "漲跌（1月）", "52W High": "52週最高", "52W Low": "52週最低",
    "P/E Ratio": "本益比", "Day's Range": "當日區間", "Key Signals": "關鍵訊號",
    "Pick a ticker to compute signals…": "請選擇標的以計算訊號…",
    "Latest News": "最新新聞", "Pick a ticker for news…": "請選擇標的以查看新聞…",
    "Invitation code": "邀請碼", "Enter your invitation code": "請輸入您的邀請碼",
    "Enter": "進入", "Save & continue": "儲存並繼續", "Skip for now": "暫時略過", "Close": "關閉",
    "DeepSeek API key": "DeepSeek API 金鑰", "required to analyze / chat": "分析/聊天必填",
    "Alpaca key": "Alpaca 金鑰", "optional · paper · for Portfolio": "可選 · 模擬盤 · 用於投資組合",
    "Alpaca secret": "Alpaca 私鑰",
    "Appearance": "外觀", "Choose a dark or light interface theme.": "選擇深色或淺色介面主題。",
    "Dark": "深色", "Light": "淺色", "Language": "語言",
    "Language of the interface and, by default, agent reports.": "介面語言，並預設作為智能體報告語言。",
    "Export report": "匯出報告",
    "Tick the sections to export. One = .md or PDF; several = a .zip.": "勾選要匯出的部分。單個為 .md 或 PDF；多個為 .zip。",
    "Markdown (.md)": "Markdown (.md)", "PDF": "PDF", "ZIP (.zip)": "ZIP (.zip)",
    "Bull vs. Bear Debate": "多空辯論", "Judge Verdict": "裁判結論",
    "★ Everything (full report)": "★ 全部（完整報告）",
    "Provider": "提供方", "Debate depth": "辯論深度", "Shallow": "淺", "Medium": "中", "Deep": "深",
    "Collectors": "資料收集", "Technical": "技術面",
  },
  "French": {
    "Trading Portal": "Portail de trading",
    "Your Faithful Trading Companion": "Votre fidèle compagnon de trading",
    "Dashboard": "Tableau de bord", "Agent Coordination": "Coordination des agents",
    "Watchlist": "Liste de suivi", "Markets": "Marchés", "Screener": "Filtre",
    "News": "Actualités", "Smart Money": "Capitaux avisés", "AI Analysis": "Analyse IA",
    "Backtester": "Backtest", "Alerts": "Alertes", "Portfolio": "Portefeuille",
    "Settings": "Paramètres", "Market Status": "État du marché", "US Market opens in": "Ouverture US dans",
    "HRS": "H", "MIN": "MIN", "SEC": "SEC", "API keys": "Clés API", "Sign out": "Se déconnecter",
    "Exchange": "Bourse", "Search stocks, indices, news…": "Rechercher actions, indices, actualités…",
    "pick a ticker": "choisir un symbole", "▸ Run agents": "▸ Lancer les agents",
    "Pick a ticker to begin": "Choisissez un symbole pour commencer",
    "Open": "Ouverture", "High": "Haut", "Low": "Bas", "Prev Close": "Clôture préc.",
    "Volume": "Volume", "Market Cap": "Capitalisation",
    "Pick a ticker to load the interactive chart…": "Choisissez un symbole pour charger le graphique…",
    "Overview": "Aperçu", "Fundamentals": "Fondamentaux", "Financials": "Finances", "Technicals": "Technique",
    "Company overview": "Aperçu de l'entreprise", "Run agent analysis →": "Lancer l'analyse des agents →",
    "Pick a ticker to load the company overview…": "Choisissez un symbole pour l'aperçu de l'entreprise…",
    "Select a ticker to load fundamentals.": "Choisissez un symbole pour les fondamentaux.",
    "Pick a ticker to load financials…": "Choisissez un symbole pour les finances…",
    "Loading technicals…": "Chargement de la technique…",
    "Add a ticker with the ☆ to track it here.": "Ajoutez un symbole avec ☆ pour le suivre ici.",
    "Quick Overview": "Aperçu rapide", "Change (1D)": "Var. (1J)", "Change (5D)": "Var. (5J)",
    "Change (1M)": "Var. (1M)", "52W High": "Plus haut 52s", "52W Low": "Plus bas 52s",
    "P/E Ratio": "Ratio C/B", "Day's Range": "Plage du jour", "Key Signals": "Signaux clés",
    "Pick a ticker to compute signals…": "Choisissez un symbole pour calculer les signaux…",
    "Latest News": "Dernières actualités", "Pick a ticker for news…": "Choisissez un symbole pour les actualités…",
    "Invitation code": "Code d'invitation", "Enter your invitation code": "Saisissez votre code d'invitation",
    "Enter": "Entrer", "Save & continue": "Enregistrer et continuer", "Skip for now": "Ignorer pour l'instant", "Close": "Fermer",
    "DeepSeek API key": "Clé API DeepSeek", "required to analyze / chat": "requise pour analyser / discuter",
    "Alpaca key": "Clé Alpaca", "optional · paper · for Portfolio": "optionnel · papier · pour le Portefeuille",
    "Alpaca secret": "Secret Alpaca",
    "Appearance": "Apparence", "Choose a dark or light interface theme.": "Choisissez un thème d'interface clair ou sombre.",
    "Dark": "Sombre", "Light": "Clair", "Language": "Langue",
    "Language of the interface and, by default, agent reports.": "Langue de l'interface et, par défaut, des rapports des agents.",
    "Export report": "Exporter le rapport",
    "Tick the sections to export. One = .md or PDF; several = a .zip.": "Cochez les sections à exporter. Une = .md ou PDF ; plusieurs = un .zip.",
    "Markdown (.md)": "Markdown (.md)", "PDF": "PDF", "ZIP (.zip)": "ZIP (.zip)",
    "Bull vs. Bear Debate": "Débat haussier/baissier", "Judge Verdict": "Verdict du juge",
    "★ Everything (full report)": "★ Tout (rapport complet)",
    "Provider": "Fournisseur", "Debate depth": "Profondeur du débat", "Shallow": "Légère", "Medium": "Moyenne", "Deep": "Profonde",
    "Collectors": "Collecteurs", "Technical": "Technique",
  },
};

// Extended coverage for the deeper pages (Markets, News, Smart Money, Portfolio,
// Backtester, Global). Merged in so the core dictionary above stays readable.
Object.assign(I18N["Simplified Chinese"], {
  "Smart Money": "资金流向", "🐋 Smart money tracker": "🐋 资金流向追踪",
  "⭐ Watchlist": "⭐ 自选列表", "🥊 Bull vs. Bear debate": "🥊 多空辩论",
  "Global Markets": "全球市场", "Portfolio Performance": "投资组合表现", "Positions": "持仓",
  "Recent Orders": "近期订单", "Asset Allocation": "资产配置", "Place Paper Order": "模拟下单",
  "Trade Log": "交易记录", "Strategy Code": "策略代码", "Equity Curve": "净值曲线",
  "Drawdown": "回撤", "Monthly Returns (%)": "月度收益（%）", "Comparison Analysis": "对比分析",
  "Company Calendar": "公司日历", "Estimates": "预期", "Economic Calendar": "经济日历",
  "Key Risk Indicators": "关键风险指标", "Asset-Class Leaders": "各类资产领涨",
  "Global Equity Indices": "全球股指", "Global Bond Yields": "全球债券收益率",
  "FX Major Pairs": "主要货币对", "Global Heatmap": "全球热力图", "TRADE BUDDY ANALYST": "TRADE BUDDY 分析师",
  "MARKET NEWS": "市场新闻", "ALL NEWS": "全部新闻", "BREAKING NEWS": "突发新闻",
  "LIVE NEWS TAPE": "实时新闻流", "BREAKING": "突发", "HEADLINE": "标题", "IMPACT": "影响", "LIVE": "实时",
  "DATA COLLECTORS": "数据收集器", "DEBATE FLOW (LIVE)": "辩论流程（实时）",
  "AGENT COORDINATION": "智能体协作", "AI MARKET DEBATE ENGINE": "AI 市场辩论引擎",
  "Analysts collect the data. Bull & Bear argue it. The Judge decides.": "分析师收集数据，多空双方辩论，裁判定夺。",
  "BULL CASE": "看涨观点", "BEAR CASE": "看跌观点", "CONFIDENCE": "信心",
  "Analyst Reports": "分析师报告", "Debate Intensity": "辩论强度",
  "Buy": "买入", "Sell": "卖出", "Submit Order": "提交订单", "Symbol (e.g. AAPL)": "代码（如 AAPL）",
  "Quantity": "数量", "Market": "市价", "Limit": "限价",
  "GAINERS": "上涨", "LOSERS": "下跌", "ACTIVE": "活跃", "Bullish": "看涨", "Bearish": "看跌",
  "Buys": "买入", "Growth": "增长", "Inflation": "通胀", "Commodities": "大宗商品",
  "CRYPTO": "加密", "EQUITIES": "股票", "COMMODITIES": "大宗商品", "CENTRAL BANKS": "央行",
  "MACRO": "宏观", "EARNINGS": "财报",
  "Corporate insiders (CEOs & whales)": "公司内部人（CEO 与大户）",
  "Capitol Hill — House & Senate": "国会山 — 众议院与参议院",
  "Is the yield curve inverted?": "收益率曲线是否倒挂？", "Economic momentum (YoY)": "经济动能（同比）",
});
Object.assign(I18N["Traditional Chinese"], {
  "Smart Money": "資金流向", "🐋 Smart money tracker": "🐋 資金流向追蹤",
  "⭐ Watchlist": "⭐ 自選清單", "🥊 Bull vs. Bear debate": "🥊 多空辯論",
  "Global Markets": "全球市場", "Portfolio Performance": "投資組合表現", "Positions": "持倉",
  "Recent Orders": "近期訂單", "Asset Allocation": "資產配置", "Place Paper Order": "模擬下單",
  "Trade Log": "交易紀錄", "Strategy Code": "策略程式碼", "Equity Curve": "淨值曲線",
  "Drawdown": "回撤", "Monthly Returns (%)": "月度報酬（%）", "Comparison Analysis": "對比分析",
  "Company Calendar": "公司行事曆", "Estimates": "預期", "Economic Calendar": "經濟行事曆",
  "Key Risk Indicators": "關鍵風險指標", "Asset-Class Leaders": "各類資產領漲",
  "Global Equity Indices": "全球股指", "Global Bond Yields": "全球債券殖利率",
  "FX Major Pairs": "主要貨幣對", "Global Heatmap": "全球熱力圖", "TRADE BUDDY ANALYST": "TRADE BUDDY 分析師",
  "MARKET NEWS": "市場新聞", "ALL NEWS": "全部新聞", "BREAKING NEWS": "突發新聞",
  "LIVE NEWS TAPE": "即時新聞流", "BREAKING": "突發", "HEADLINE": "標題", "IMPACT": "影響", "LIVE": "即時",
  "DATA COLLECTORS": "資料收集器", "DEBATE FLOW (LIVE)": "辯論流程（即時）",
  "AGENT COORDINATION": "智能體協作", "AI MARKET DEBATE ENGINE": "AI 市場辯論引擎",
  "Analysts collect the data. Bull & Bear argue it. The Judge decides.": "分析師收集資料，多空雙方辯論，裁判定奪。",
  "BULL CASE": "看漲觀點", "BEAR CASE": "看跌觀點", "CONFIDENCE": "信心",
  "Analyst Reports": "分析師報告", "Debate Intensity": "辯論強度",
  "Buy": "買入", "Sell": "賣出", "Submit Order": "提交訂單", "Symbol (e.g. AAPL)": "代碼（如 AAPL）",
  "Quantity": "數量", "Market": "市價", "Limit": "限價",
  "GAINERS": "上漲", "LOSERS": "下跌", "ACTIVE": "活躍", "Bullish": "看漲", "Bearish": "看跌",
  "Buys": "買入", "Growth": "增長", "Inflation": "通膨", "Commodities": "大宗商品",
  "CRYPTO": "加密", "EQUITIES": "股票", "COMMODITIES": "大宗商品", "CENTRAL BANKS": "央行",
  "MACRO": "宏觀", "EARNINGS": "財報",
  "Corporate insiders (CEOs & whales)": "公司內部人（CEO 與大戶）",
  "Capitol Hill — House & Senate": "國會山 — 眾議院與參議院",
  "Is the yield curve inverted?": "殖利率曲線是否倒掛？", "Economic momentum (YoY)": "經濟動能（同比）",
});
Object.assign(I18N["French"], {
  "Smart Money": "Capitaux avisés", "🐋 Smart money tracker": "🐋 Suivi des capitaux avisés",
  "⭐ Watchlist": "⭐ Liste de suivi", "🥊 Bull vs. Bear debate": "🥊 Débat haussier/baissier",
  "Global Markets": "Marchés mondiaux", "Portfolio Performance": "Performance du portefeuille", "Positions": "Positions",
  "Recent Orders": "Ordres récents", "Asset Allocation": "Allocation d'actifs", "Place Paper Order": "Passer un ordre (papier)",
  "Trade Log": "Journal des trades", "Strategy Code": "Code de stratégie", "Equity Curve": "Courbe de capital",
  "Drawdown": "Drawdown", "Monthly Returns (%)": "Rendements mensuels (%)", "Comparison Analysis": "Analyse comparative",
  "Company Calendar": "Calendrier de l'entreprise", "Estimates": "Estimations", "Economic Calendar": "Calendrier économique",
  "Key Risk Indicators": "Indicateurs de risque clés", "Asset-Class Leaders": "Leaders par classe d'actifs",
  "Global Equity Indices": "Indices boursiers mondiaux", "Global Bond Yields": "Rendements obligataires mondiaux",
  "FX Major Pairs": "Paires de devises majeures", "Global Heatmap": "Carte de chaleur mondiale", "TRADE BUDDY ANALYST": "ANALYSTE TRADE BUDDY",
  "MARKET NEWS": "ACTUALITÉS DU MARCHÉ", "ALL NEWS": "TOUTES LES ACTUS", "BREAKING NEWS": "DERNIÈRE MINUTE",
  "LIVE NEWS TAPE": "FIL D'ACTUALITÉS EN DIRECT", "BREAKING": "URGENT", "HEADLINE": "TITRE", "IMPACT": "IMPACT", "LIVE": "EN DIRECT",
  "DATA COLLECTORS": "COLLECTEURS DE DONNÉES", "DEBATE FLOW (LIVE)": "FLUX DU DÉBAT (EN DIRECT)",
  "AGENT COORDINATION": "COORDINATION DES AGENTS", "AI MARKET DEBATE ENGINE": "MOTEUR DE DÉBAT DE MARCHÉ IA",
  "Analysts collect the data. Bull & Bear argue it. The Judge decides.": "Les analystes collectent les données. Haussiers et baissiers débattent. Le juge tranche.",
  "BULL CASE": "THÈSE HAUSSIÈRE", "BEAR CASE": "THÈSE BAISSIÈRE", "CONFIDENCE": "CONFIANCE",
  "Analyst Reports": "Rapports d'analystes", "Debate Intensity": "Intensité du débat",
  "Buy": "Acheter", "Sell": "Vendre", "Submit Order": "Soumettre l'ordre", "Symbol (e.g. AAPL)": "Symbole (ex. AAPL)",
  "Quantity": "Quantité", "Market": "Marché", "Limit": "Limite",
  "GAINERS": "HAUSSES", "LOSERS": "BAISSES", "ACTIVE": "ACTIFS", "Bullish": "Haussier", "Bearish": "Baissier",
  "Buys": "Achats", "Growth": "Croissance", "Inflation": "Inflation", "Commodities": "Matières premières",
  "CRYPTO": "CRYPTO", "EQUITIES": "ACTIONS", "COMMODITIES": "MATIÈRES PREMIÈRES", "CENTRAL BANKS": "BANQUES CENTRALES",
  "MACRO": "MACRO", "EARNINGS": "RÉSULTATS",
  "Corporate insiders (CEOs & whales)": "Initiés (PDG et gros porteurs)",
  "Capitol Hill — House & Senate": "Capitole — Chambre et Sénat",
  "Is the yield curve inverted?": "La courbe des taux est-elle inversée ?", "Economic momentum (YoY)": "Élan économique (sur un an)",
});

// AI Analysis page + Watchlist + analyst greeting.
Object.assign(I18N["Simplified Chinese"], {
  "Company Analysis": "公司分析", "Technical Analysis": "技术分析", "Ownership": "持股结构",
  "Enter a ticker to load company analysis…": "输入代码以加载公司分析…",
  "Ticker (e.g. AAPL)": "代码（如 AAPL）",
  "Your tracked stocks — click a row to open it": "您关注的股票 — 点击某行打开",
  "Add stocks with the ☆ next to a ticker.": "用代码旁的 ☆ 添加股票。",
  "Macro & markets · reasons, then cites live data and past analyses": "宏观与市场 · 先推理，再引用实时数据与历史分析",
  "Macro & markets analyst online. Ask about inflation, rates, the yield curve, market news, a ticker's fundamentals/technicals, or a prior verdict — I'll reason, pull live data, and cite the source.": "宏观与市场分析师已上线。可询问通胀、利率、收益率曲线、市场新闻、某标的的基本面/技术面，或既往结论——我会推理、拉取实时数据并标注来源。",
  "Sentiment": "情绪", "Macro": "宏观",
  "Technical Analyst": "技术分析师", "Fundamentals Analyst": "基本面分析师", "News Analyst": "新闻分析师",
  "Sentiment Analyst": "情绪分析师", "Smart-Money Analyst": "资金流向分析师", "Macro Analyst": "宏观分析师",
  "Market Analyst": "技术分析师", "Bull Researcher": "看涨研究员", "Bear Researcher": "看跌研究员", "Judge": "裁判",
  "Charts · indicators · price action": "图表 · 指标 · 价格行为", "Statements · valuation · filings": "财报 · 估值 · 文件",
  "Headlines · catalysts · events": "头条 · 催化剂 · 事件", "Social chatter · retail mood": "社交讨论 · 散户情绪",
  "Insiders · congress · flows": "内部人 · 国会 · 资金流", "Rates · inflation · growth · labor": "利率 · 通胀 · 增长 · 就业",
  "MARKET DEBATE ARENA": "市场辩论竞技场", "VERDICT DRIVERS": "结论驱动因素", "Judge's weighting": "裁判权重", "TOP EVIDENCE": "关键证据",
  "Export": "导出", "● Idle": "● 空闲",
  "Delete session": "删除会话", "Delete this chat session?": "确定删除此会话吗？", "No past sessions yet.": "暂无历史会话。",
  "Select all": "全选", "Delete selected": "删除所选", "Delete the selected sessions?": "确定删除所选会话吗？",
  "Whale Trading": "鲸鱼交易", "Congress": "国会", "Members": "议员", "Insiders": "内部人",
  "Options Flow": "期权流", "Dark Pool": "暗池", "Signal Engine": "信号引擎", "Investors": "知名投资者",
  "Crypto Whales": "加密鲸鱼", "Heatmap": "热力图", "Calendar": "日历", "Filter": "筛选",
  "Pipeline events stream here during a run.": "运行时流程事件将在此显示。",
  "Run an analysis to see each collector's full report.": "运行分析以查看每个收集器的完整报告。",
  "The Judge's full verdict appears here.": "裁判的完整结论将在此显示。",
  "The Judge's scoreboard appears here after a run.": "运行后裁判的评分表将在此显示。",
});
Object.assign(I18N["Traditional Chinese"], {
  "Company Analysis": "公司分析", "Technical Analysis": "技術分析", "Ownership": "持股結構",
  "Enter a ticker to load company analysis…": "輸入代碼以載入公司分析…",
  "Ticker (e.g. AAPL)": "代碼（如 AAPL）",
  "Your tracked stocks — click a row to open it": "您關注的股票 — 點擊某列開啟",
  "Add stocks with the ☆ next to a ticker.": "用代碼旁的 ☆ 新增股票。",
  "Macro & markets · reasons, then cites live data and past analyses": "宏觀與市場 · 先推理，再引用即時數據與歷史分析",
  "Macro & markets analyst online. Ask about inflation, rates, the yield curve, market news, a ticker's fundamentals/technicals, or a prior verdict — I'll reason, pull live data, and cite the source.": "宏觀與市場分析師已上線。可詢問通膨、利率、殖利率曲線、市場新聞、某標的的基本面/技術面，或既往結論——我會推理、拉取即時數據並標註來源。",
  "Sentiment": "情緒", "Macro": "宏觀",
  "Technical Analyst": "技術分析師", "Fundamentals Analyst": "基本面分析師", "News Analyst": "新聞分析師",
  "Sentiment Analyst": "情緒分析師", "Smart-Money Analyst": "資金流向分析師", "Macro Analyst": "宏觀分析師",
  "Market Analyst": "技術分析師", "Bull Researcher": "看漲研究員", "Bear Researcher": "看跌研究員", "Judge": "裁判",
  "Charts · indicators · price action": "圖表 · 指標 · 價格行為", "Statements · valuation · filings": "財報 · 估值 · 文件",
  "Headlines · catalysts · events": "頭條 · 催化劑 · 事件", "Social chatter · retail mood": "社交討論 · 散戶情緒",
  "Insiders · congress · flows": "內部人 · 國會 · 資金流", "Rates · inflation · growth · labor": "利率 · 通膨 · 增長 · 就業",
  "MARKET DEBATE ARENA": "市場辯論競技場", "VERDICT DRIVERS": "結論驅動因素", "Judge's weighting": "裁判權重", "TOP EVIDENCE": "關鍵證據",
  "Export": "匯出", "● Idle": "● 閒置",
  "Delete session": "刪除工作階段", "Delete this chat session?": "確定刪除此工作階段嗎？", "No past sessions yet.": "尚無歷史工作階段。",
  "Select all": "全選", "Delete selected": "刪除所選", "Delete the selected sessions?": "確定刪除所選工作階段嗎？",
  "Whale Trading": "鯨魚交易", "Congress": "國會", "Members": "議員", "Insiders": "內部人",
  "Options Flow": "選擇權流", "Dark Pool": "暗池", "Signal Engine": "訊號引擎", "Investors": "知名投資者",
  "Crypto Whales": "加密鯨魚", "Heatmap": "熱力圖", "Calendar": "日曆", "Filter": "篩選",
  "Pipeline events stream here during a run.": "執行時流程事件將在此顯示。",
  "Run an analysis to see each collector's full report.": "執行分析以查看每個收集器的完整報告。",
  "The Judge's full verdict appears here.": "裁判的完整結論將在此顯示。",
  "The Judge's scoreboard appears here after a run.": "執行後裁判的評分表將在此顯示。",
});
Object.assign(I18N["French"], {
  "Company Analysis": "Analyse d'entreprise", "Technical Analysis": "Analyse technique", "Ownership": "Actionnariat",
  "Enter a ticker to load company analysis…": "Saisissez un symbole pour charger l'analyse…",
  "Ticker (e.g. AAPL)": "Symbole (ex. AAPL)",
  "Your tracked stocks — click a row to open it": "Vos titres suivis — cliquez une ligne pour l'ouvrir",
  "Add stocks with the ☆ next to a ticker.": "Ajoutez des titres avec le ☆ près d'un symbole.",
  "Macro & markets · reasons, then cites live data and past analyses": "Macro et marchés · raisonne, puis cite les données en direct et les analyses passées",
  "Macro & markets analyst online. Ask about inflation, rates, the yield curve, market news, a ticker's fundamentals/technicals, or a prior verdict — I'll reason, pull live data, and cite the source.": "Analyste macro et marchés en ligne. Posez des questions sur l'inflation, les taux, la courbe des taux, l'actualité du marché, les fondamentaux/techniques d'un titre, ou un verdict passé — je raisonne, récupère les données en direct et cite la source.",
  "Sentiment": "Sentiment", "Macro": "Macro",
  "Technical Analyst": "Analyste technique", "Fundamentals Analyst": "Analyste fondamental", "News Analyst": "Analyste actualités",
  "Sentiment Analyst": "Analyste de sentiment", "Smart-Money Analyst": "Analyste capitaux avisés", "Macro Analyst": "Analyste macro",
  "Market Analyst": "Analyste de marché", "Bull Researcher": "Chercheur haussier", "Bear Researcher": "Chercheur baissier", "Judge": "Juge",
  "Charts · indicators · price action": "Graphiques · indicateurs · prix", "Statements · valuation · filings": "États · valorisation · dépôts",
  "Headlines · catalysts · events": "Titres · catalyseurs · événements", "Social chatter · retail mood": "Réseaux · humeur des particuliers",
  "Insiders · congress · flows": "Initiés · Congrès · flux", "Rates · inflation · growth · labor": "Taux · inflation · croissance · emploi",
  "MARKET DEBATE ARENA": "ARÈNE DE DÉBAT", "VERDICT DRIVERS": "FACTEURS DU VERDICT", "Judge's weighting": "Pondération du juge", "TOP EVIDENCE": "PREUVES CLÉS",
  "Export": "Exporter", "● Idle": "● Inactif",
  "Delete session": "Supprimer la session", "Delete this chat session?": "Supprimer cette session de discussion ?", "No past sessions yet.": "Aucune session passée.",
  "Select all": "Tout sélectionner", "Delete selected": "Supprimer la sélection", "Delete the selected sessions?": "Supprimer les sessions sélectionnées ?",
  "Whale Trading": "Trading des baleines", "Congress": "Congrès", "Members": "Membres", "Insiders": "Initiés",
  "Options Flow": "Flux d'options", "Dark Pool": "Dark Pool", "Signal Engine": "Moteur de signaux", "Investors": "Investisseurs",
  "Crypto Whales": "Baleines crypto", "Heatmap": "Carte de chaleur", "Calendar": "Calendrier", "Filter": "Filtrer",
  "Pipeline events stream here during a run.": "Les événements du pipeline défilent ici pendant un run.",
  "Run an analysis to see each collector's full report.": "Lancez une analyse pour voir le rapport complet de chaque collecteur.",
  "The Judge's full verdict appears here.": "Le verdict complet du juge apparaît ici.",
  "The Judge's scoreboard appears here after a run.": "Le tableau de scores du juge apparaît ici après un run.",
});

// Backtester page + remaining placeholders.
Object.assign(I18N["Simplified Chinese"], {
  "Run a backtest to see the equity curve.": "运行回测以查看净值曲线。", "No trades yet.": "暂无交易。",
  "Write a strategy and run.": "编写策略并运行。", "▶ Run Backtest": "▶ 运行回测",
  "✕ Close": "✕ 关闭", "⤢ Expand": "⤢ 展开", "⧉ Copy": "⧉ 复制",
  "Bars": "K线数", "Capital": "资金", "Define": "定义", "From": "自", "To": "至", "Ticker": "代码",
  "1 day (full)": "1天（完整）", "1 hour (≤2y)": "1小时（≤2年）", "1 min (≤7d)": "1分钟（≤7天）",
  "15 min (≤60d)": "15分钟（≤60天）", "30 min (≤60d)": "30分钟（≤60天）", "5 min (≤60d)": "5分钟（≤60天）",
  "🔔 Alerts — coming soon": "🔔 提醒 — 即将推出", "🔎 Screener — coming soon": "🔎 选股器 — 即将推出",
});
Object.assign(I18N["Traditional Chinese"], {
  "Run a backtest to see the equity curve.": "執行回測以查看淨值曲線。", "No trades yet.": "暫無交易。",
  "Write a strategy and run.": "編寫策略並執行。", "▶ Run Backtest": "▶ 執行回測",
  "✕ Close": "✕ 關閉", "⤢ Expand": "⤢ 展開", "⧉ Copy": "⧉ 複製",
  "Bars": "K線數", "Capital": "資金", "Define": "定義", "From": "自", "To": "至", "Ticker": "代碼",
  "1 day (full)": "1天（完整）", "1 hour (≤2y)": "1小時（≤2年）", "1 min (≤7d)": "1分鐘（≤7天）",
  "15 min (≤60d)": "15分鐘（≤60天）", "30 min (≤60d)": "30分鐘（≤60天）", "5 min (≤60d)": "5分鐘（≤60天）",
  "🔔 Alerts — coming soon": "🔔 提醒 — 即將推出", "🔎 Screener — coming soon": "🔎 選股器 — 即將推出",
});
Object.assign(I18N["French"], {
  "Run a backtest to see the equity curve.": "Lancez un backtest pour voir la courbe de capital.", "No trades yet.": "Aucun trade pour l'instant.",
  "Write a strategy and run.": "Écrivez une stratégie et lancez-la.", "▶ Run Backtest": "▶ Lancer le backtest",
  "✕ Close": "✕ Fermer", "⤢ Expand": "⤢ Agrandir", "⧉ Copy": "⧉ Copier",
  "Bars": "Barres", "Capital": "Capital", "Define": "Définir", "From": "De", "To": "À", "Ticker": "Symbole",
  "1 day (full)": "1 jour (complet)", "1 hour (≤2y)": "1 heure (≤2a)", "1 min (≤7d)": "1 min (≤7j)",
  "15 min (≤60d)": "15 min (≤60j)", "30 min (≤60d)": "30 min (≤60j)", "5 min (≤60d)": "5 min (≤60j)",
  "🔔 Alerts — coming soon": "🔔 Alertes — bientôt disponible", "🔎 Screener — coming soon": "🔎 Filtre — bientôt disponible",
});

const _LANG_HTML = {
  "English": "en", "Simplified Chinese": "zh-Hans",
  "Traditional Chinese": "zh-Hant", "French": "fr",
};

// Subtrees whose text is dynamic / data-bearing — never touched by the walker.
const _I18N_SKIP = "#tv-chart, .kline-pro, .js-plotly-plot, .report-body, .chat-log, "
  + "#export-preview, .suggestions, .ind-sug, .news-list, .dash-overview, svg, script, style";

const _i18nBaseText = new WeakMap();   // textNode -> original English
const _i18nBaseAttr = new WeakMap();   // element  -> {attr: originalEnglish}

function _i18nTr(s, lang) {
  if (!s || lang === "English") return s;
  const dict = I18N[lang]; if (!dict) return s;
  const key = s.trim(); if (!key) return s;
  const hit = dict[key];
  return hit ? s.replace(key, hit) : s;
}

function _i18nWalk(node, lang) {
  if (node.nodeType === 3) { // text node
    if (!_i18nBaseText.has(node)) _i18nBaseText.set(node, node.nodeValue);
    const out = _i18nTr(_i18nBaseText.get(node), lang);
    if (node.nodeValue !== out) node.nodeValue = out;
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node;
  if (el.hasAttribute("data-no-i18n")) return;
  if (el.matches && el.matches(_I18N_SKIP)) return;
  if (el.closest && el.closest(_I18N_SKIP)) return;
  for (const a of ["placeholder", "title", "aria-label"]) {
    if (el.hasAttribute(a)) {
      let base = _i18nBaseAttr.get(el);
      if (!base) { base = {}; _i18nBaseAttr.set(el, base); }
      if (!(a in base)) base[a] = el.getAttribute(a);
      el.setAttribute(a, _i18nTr(base[a], lang));
    }
  }
  for (const c of Array.from(el.childNodes)) _i18nWalk(c, lang);
}

function applyLang(lang) {
  lang = I18N[lang] ? lang : "English";
  window.__i18nLang = lang;
  try { localStorage.setItem("tb_lang", lang); } catch {}
  document.documentElement.lang = _LANG_HTML[lang] || "en";
  _i18nWalk(document.body, lang);
  const uiSel = document.getElementById("ui-language");
  if (uiSel && uiSel.value !== lang) uiSel.value = lang;
}
window.__applyLang = () => applyLang(window.__i18nLang || "English");

// Theme-specific bull logo: a dark-matted, high-res version for dark mode (clean
// edges on near-black), the cleaned light version otherwise. Only the chrome
// logos swap (sidebar + auth); the arena mascot keeps the standard art.
const _BULL_SRC = { dark: "/static/bull_dark.png?v=6", light: "/static/bull.png?v=7" };
function _applyBullLogo(t) {
  const src = _BULL_SRC[t] || _BULL_SRC.dark;
  document.querySelectorAll(".auth-logo, .logo-img").forEach((img) => {
    if (img.getAttribute("src") !== src) img.src = src;
  });
}

function applyTheme(t) {
  t = (t === "light") ? "light" : "dark";
  window.__theme = t;
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("tb_theme", t); } catch {}
  document.querySelectorAll(".theme-opt").forEach((b) =>
    b.classList.toggle("active", b.dataset.themeVal === t));
  _applyBullLogo(t);
}

// Wire Settings controls.
document.querySelectorAll(".theme-opt").forEach((b) =>
  b.addEventListener("click", () => applyTheme(b.dataset.themeVal)));
document.getElementById("ui-language")?.addEventListener("change", (e) => {
  const lang = e.target.value;
  applyLang(lang);
  // The UI language is also the sensible default for new analysis runs.
  const runSel = document.getElementById("language");
  if (runSel) runSel.value = lang;
});
// Re-translate after a page switch. Several panels fetch then render their
// labels asynchronously, so re-apply a few times to catch late content.
function _reapplyLangSoon() {
  const lang = window.__i18nLang || "English";
  if (lang === "English") return;
  [0, 300, 900, 1800].forEach((ms) => setTimeout(() => applyLang(lang), ms));
}
document.querySelector(".nav")?.addEventListener("click", _reapplyLangSoon);

// Apply persisted appearance + language on boot.
(function _initAppearance() {
  let theme = "dark", lang = "English";
  try { theme = localStorage.getItem("tb_theme") || "dark"; } catch {}
  try { lang = localStorage.getItem("tb_lang") || "English"; } catch {}
  applyTheme(theme);
  const runSel = document.getElementById("language");
  if (runSel && I18N[lang]) runSel.value = lang;
  applyLang(lang);
  // Account text + a few labels render slightly after boot; re-apply once.
  setTimeout(() => applyLang(window.__i18nLang || "English"), 400);
})();
