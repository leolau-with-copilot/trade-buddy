"use strict";

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
let sugItems = [];
let sugActive = -1;
let searchTimer = null;

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

async function runSearch(q) {
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    sugItems = await r.json();
  } catch { sugItems = []; }
  renderSuggestions();
}
function renderSuggestions() {
  sugEl.innerHTML = "";
  sugActive = -1;
  if (!sugItems.length) { hideSuggestions(); return; }
  sugItems.forEach((it, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span><span class="sym">${it.symbol}</span> ${it.name || ""}</span>`
                 + `<span class="exch">${it.exchange || ""} ${it.type || ""}</span>`;
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
}

// --------------------------------------------------------------------------- //
// Price chart (KlineCharts)
// --------------------------------------------------------------------------- //
document.getElementById("ranges").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  currentRange = btn.dataset.range;
  [...e.currentTarget.children].forEach((b) => b.classList.toggle("active", b === btn));
  if (currentTicker) loadPrices();
});

// --- Indicator search ---
const indSearchEl = document.getElementById("ind-search");
const indSugEl    = document.getElementById("ind-sug");
let indSugItems = [], indSugActive = -1;

indSearchEl.addEventListener("input", () => {
  const q = indSearchEl.value.trim().toUpperCase();
  if (!q) { _hideIndSug(); return; }
  indSugItems = IND_CATALOG.filter(
    (ind) => ind.name.includes(q) || ind.label.toUpperCase().includes(q)
  );
  _renderIndSug();
});
indSearchEl.addEventListener("keydown", (e) => {
  if (!indSugEl.classList.contains("show")) return;
  if (e.key === "ArrowDown")  { e.preventDefault(); _moveIndActive(1); }
  else if (e.key === "ArrowUp")   { e.preventDefault(); _moveIndActive(-1); }
  else if (e.key === "Enter") { e.preventDefault(); if (indSugActive >= 0) _pickInd(indSugItems[indSugActive]); }
  else if (e.key === "Escape") _hideIndSug();
});
document.addEventListener("click", (e) => {
  if (!indSearchEl.contains(e.target) && !indSugEl.contains(e.target)) _hideIndSug();
});

function _renderIndSug() {
  indSugEl.innerHTML = "";
  indSugActive = -1;
  if (!indSugItems.length) { _hideIndSug(); return; }
  indSugItems.forEach((ind, i) => {
    const li = document.createElement("li");
    const isActive = !!_indPanes[ind.name];
    if (isActive) li.classList.add("is-active");
    const color = IND_COLORS[ind.name] || "#8b949e";
    li.innerHTML = `<span class="is-name" style="color:${color}">${ind.name}</span>`
                 + `<span class="is-label">${ind.label}</span>`
                 + `<span class="is-badge">${ind.overlay ? "overlay" : "sub-pane"}</span>`
                 + `<span class="is-action">${isActive ? "\u2715 remove" : "+ add"}</span>`;
    li.addEventListener("mouseenter", () => { indSugActive = i; _hlInd(); });
    li.addEventListener("click", () => _pickInd(ind));
    indSugEl.appendChild(li);
  });
  indSugEl.classList.add("show");
}
function _hlInd() {
  [...indSugEl.children].forEach((li, i) => li.classList.toggle("hover", i === indSugActive));
}
function _moveIndActive(d) {
  indSugActive = (indSugActive + d + indSugItems.length) % indSugItems.length;
  _hlInd();
}
function _hideIndSug() {
  indSugEl.classList.remove("show");
  indSugItems = []; indSugActive = -1;
}
function _pickInd(ind) {
  if (_indPanes[ind.name]) _removeIndicator(ind.name);
  else _addIndicator(ind.name, ind.overlay);
  indSearchEl.value = "";
  _hideIndSug();
}

// --- Indicator chip rendering ---
function _renderChips() {
  const wrap = document.getElementById("active-inds");
  wrap.innerHTML = "";
  for (const name of Object.keys(_indPanes)) {
    const chip = document.createElement("span");
    chip.className = "ind-chip";
    const color = IND_COLORS[name] || "#8b949e";
    chip.style.setProperty("--chip-color", color);
    chip.innerHTML = `${name}<button class="ind-chip-x" aria-label="Remove ${name}">×</button>`;
    chip.querySelector(".ind-chip-x").addEventListener("click", () => _removeIndicator(name));
    wrap.appendChild(chip);
  }
}

function _addIndicator(name, overlay) {
  if (!_chart || _indPanes[name] !== undefined) return;
  if (overlay) {
    _chart.createIndicator(name, false, { id: "candle_pane" });
    _indPanes[name] = "candle_pane";
  } else {
    _indPanes[name] = _chart.createIndicator(name, false);
  }
  _renderChips();
}
function _removeIndicator(name) {
  if (!_chart || _indPanes[name] === undefined) return;
  _chart.removeIndicator(_indPanes[name], name);
  delete _indPanes[name];
  _renderChips();
}

function _initChart() {
  const container = document.getElementById("tv-chart");
  container.innerHTML = "";
  Object.keys(_indPanes).forEach((k) => delete _indPanes[k]);
  _chart = klinecharts.init("tv-chart");
  _chart.setStyles("dark");
  _addIndicator("MA",  true);
  _addIndicator("VOL", false);
  new ResizeObserver(() => { if (_chart) _chart.resize(); }).observe(container);
}

function _applyPriceData(data) {
  if (!_chart) _initChart();
  const candles = (data.candles || []).map((p) => ({
    timestamp: p.t,
    open:   p.o,
    high:   p.h,
    low:    p.l,
    close:  p.c,
    volume: p.v,
  }));
  _chart.applyNewData(candles);
  // Auto-scale bar width so small ranges fill the chart instead of squeezing right
  if (candles.length > 0) {
    const w = document.getElementById("tv-chart").clientWidth || 800;
    const space = Math.min(Math.max(Math.floor(w * 0.90 / candles.length), 4), 20);
    _chart.setDataSpace(space);
    _chart.scrollToRealTime();
  }
}

async function loadPrices() {
  if (!currentTicker) return;
  const r = await fetch(`/api/prices?ticker=${encodeURIComponent(currentTicker)}&range=${currentRange}`);
  _lastPriceData = await r.json();
  const data = _lastPriceData;

  document.getElementById("quote-symbol").textContent = currentTicker;
  document.getElementById("quote-last").textContent = data.last != null ? data.last.toFixed(2) : "";
  const chg = document.getElementById("quote-change");
  if (data.change_pct != null) {
    chg.textContent = `${data.change_pct >= 0 ? "▲" : "▼"} ${data.change_pct.toFixed(2)}%`;
    chg.className = "change " + (data.change_pct >= 0 ? "up" : "down");
  } else { chg.textContent = ""; }

  _applyPriceData(data);
}

// --------------------------------------------------------------------------- //
// Agent coordination graph
// --------------------------------------------------------------------------- //
const SVG = "http://www.w3.org/2000/svg";
const VBW = 840;                // viewBox width (matches index.html)
const W = 228, H = 80;          // enlarged node "brackets" — wide enough for the
                                // longest label ("Fundamentals Analyst").
const NODES = {
  "Market Analyst":       { x: 20,  y: 80,  role: "technical",    avatar: "📈" },
  "Fundamentals Analyst": { x: 20,  y: 210, role: "fundamentals", avatar: "📊" },
  "News Analyst":         { x: 20,  y: 340, role: "news",         avatar: "📰" },
  "Sentiment Analyst":    { x: 20,  y: 470, role: "sentiment",    avatar: "💬" },
  "Bull Researcher":      { x: 330, y: 180, role: "ToT · bull",   avatar: "🐂", cls: "bull" },
  "Bear Researcher":      { x: 330, y: 420, role: "ToT · bear",   avatar: "🐻", cls: "bear" },
  "Judge":                { x: 600, y: 300, role: "verdict",      avatar: "⚖️", cls: "judge" },
};
const EDGES = [];
["Market Analyst", "Fundamentals Analyst", "News Analyst", "Sentiment Analyst"].forEach((a) => {
  EDGES.push([a, "Bull Researcher"]); EDGES.push([a, "Bear Researcher"]);
});
EDGES.push(["Bull Researcher", "Judge"]);
EDGES.push(["Bear Researcher", "Judge"]);

const graph = document.getElementById("graph");
const nodeEls = {};
const bubbleEls = {};
const edgeEls = {};

function cy(n) { return NODES[n].y + H / 2; }

function buildGraph() {
  graph.innerHTML = "";
  Object.keys(nodeEls).forEach((k) => delete nodeEls[k]);
  Object.keys(bubbleEls).forEach((k) => delete bubbleEls[k]);
  Object.keys(edgeEls).forEach((k) => delete edgeEls[k]);

  // edges first (under nodes). A small gap (G) keeps the connectors from
  // touching the node borders, so the fan-out reads as arrows leaving the box
  // rather than a notch cut into it.
  const G = 6;
  EDGES.forEach(([s, d]) => {
    const sx = NODES[s].x + W + G, sy = cy(s), dx = NODES[d].x - G, dy = cy(d);
    const mx = (sx + dx) / 2;
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${dy}, ${dx} ${dy}`);
    path.setAttribute("class", "edge");
    graph.appendChild(path);
    edgeEls[`${s}->${d}`] = path;
  });

  // nodes
  for (const [name, n] of Object.entries(NODES)) {
    const g = document.createElementNS(SVG, "g");
    g.setAttribute("class", `node pending ${n.cls || ""}`);
    g.setAttribute("transform", `translate(${n.x},${n.y})`);

    const rect = document.createElementNS(SVG, "rect");
    rect.setAttribute("width", W); rect.setAttribute("height", H); rect.setAttribute("rx", 16);

    // Avatar disc — radius + centre chosen so it sits well inside the box
    // (16px margin top/bottom), never poking past the rounded border.
    const av = document.createElementNS(SVG, "circle");
    av.setAttribute("cx", 34); av.setAttribute("cy", H / 2); av.setAttribute("r", 18);
    av.setAttribute("class", "avatar-disc");
    const avText = document.createElementNS(SVG, "text");
    avText.setAttribute("x", 34); avText.setAttribute("y", H / 2 + 6);
    avText.setAttribute("class", "avatar"); avText.setAttribute("text-anchor", "middle");
    avText.textContent = n.avatar;

    const t1 = document.createElementNS(SVG, "text");
    t1.setAttribute("x", 64); t1.setAttribute("y", H / 2 - 4); t1.setAttribute("class", "name");
    t1.textContent = name;
    const t2 = document.createElementNS(SVG, "text");
    t2.setAttribute("x", 64); t2.setAttribute("y", H / 2 + 15); t2.setAttribute("class", "role");
    t2.textContent = n.role;

    g.appendChild(rect); g.appendChild(av); g.appendChild(avText);
    g.appendChild(t1); g.appendChild(t2);
    graph.appendChild(g);
    nodeEls[name] = g;

    // Thought bubble (hidden until the agent thinks / reports), above the node.
    buildBubble(name, n);
  }
}

const BW = 168, BH = 56;  // thought-bubble box size
function buildBubble(name, n) {
  const bx = Math.min(Math.max(n.x + W / 2 - BW / 2, 6), VBW - BW - 6);
  const by = n.y - BH - 16;
  const g = document.createElementNS(SVG, "g");
  g.setAttribute("class", "bubble");
  g.setAttribute("transform", `translate(${bx},${by})`);
  g.setAttribute("opacity", "0");

  const box = document.createElementNS(SVG, "rect");
  box.setAttribute("width", BW); box.setAttribute("height", BH);
  box.setAttribute("rx", 14); box.setAttribute("class", "bubble-box");

  const fo = document.createElementNS(SVG, "foreignObject");
  fo.setAttribute("x", 10); fo.setAttribute("y", 6);
  fo.setAttribute("width", BW - 20); fo.setAttribute("height", BH - 12);
  const div = htmlEl("div", "bubble-text");
  fo.appendChild(div);

  // A small triangle pointer joining the bubble to the node (filled to match
  // the box so it reads as one speech bubble — no stray floating dots).
  const tcx = Math.min(Math.max(n.x + W / 2 - bx, 18), BW - 18);
  const tail = document.createElementNS(SVG, "path");
  tail.setAttribute("d", `M ${tcx - 8} ${BH} L ${tcx} ${BH + 11} L ${tcx + 8} ${BH} Z`);
  tail.setAttribute("class", "bubble-tail");

  g.appendChild(box); g.appendChild(tail); g.appendChild(fo);
  graph.appendChild(g);
  bubbleEls[name] = { g, div };
}

// Tiny helper: create an XHTML element for use inside an SVG <foreignObject>.
function htmlEl(tag, cls) {
  const el = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
  el.setAttribute("class", cls);
  return el;
}

// mode: "thinking" | "countering" | null (plain text)
function showBubble(name, text, mode) {
  const b = bubbleEls[name]; if (!b) return;
  b.div.classList.toggle("thinking", mode === "thinking");
  b.div.classList.toggle("countering", mode === "countering");
  b.div.textContent = mode === "thinking" ? "thinking"
                    : mode === "countering" ? "countering"
                    : (text || "");
  b.g.setAttribute("opacity", "1");
  b.g.classList.add("show");
}
function hideBubble(name) {
  const b = bubbleEls[name]; if (!b) return;
  b.g.setAttribute("opacity", "0");
  b.g.classList.remove("show");
}

function setNodeStatus(name, status) {
  const el = nodeEls[name]; if (!el) return;
  const cls = el.getAttribute("class").replace(/\b(pending|in_progress|completed)\b/g, "").trim();
  el.setAttribute("class", `${cls} ${status}`);
  if (status === "in_progress") showBubble(name, null, "thinking");
  else if (status === "completed") hideBubble(name);
}

function flow(src, dst, summary) {
  const path = edgeEls[`${src}->${dst}`]; if (!path) return;
  path.classList.add("lit");
  const len = path.getTotalLength();

  // A glowing thought-bubble that travels along the edge carrying the topic.
  const g = document.createElementNS(SVG, "g");
  g.setAttribute("class", "msg-bubble");
  const dot = document.createElementNS(SVG, "circle");
  dot.setAttribute("r", 7); dot.setAttribute("class", "electron");
  g.appendChild(dot);
  const label = document.createElementNS(SVG, "text");
  label.setAttribute("class", "flow-label");
  label.textContent = (summary || "").slice(0, 26);
  g.appendChild(label);
  graph.appendChild(g);

  const dur = 1500, start = performance.now();
  function step(now) {
    const p = Math.min(1, (now - start) / dur);
    const pt = path.getPointAtLength(p * len);
    dot.setAttribute("cx", pt.x); dot.setAttribute("cy", pt.y);
    label.setAttribute("x", pt.x + 11); label.setAttribute("y", pt.y - 9);
    g.setAttribute("opacity", String(1 - Math.abs(p - 0.5) * 1.3));
    if (p < 1) requestAnimationFrame(step);
    else { g.remove(); setTimeout(() => path.classList.remove("lit"), 400); }
  }
  requestAnimationFrame(step);
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

function resetDebate() {
  debatePanel.hidden = true;
  debateEl.innerHTML = "";
  consensusEl.innerHTML = "";
  debateStatus.textContent = "";
}

function addDebateTurn(ev) {
  debatePanel.hidden = false;
  debateStatus.textContent = `round ${ev.round} / ${ev.rounds}`;
  const node = ev.side === "bull" ? "Bull Researcher" : "Bear Researcher";
  showBubble(node, null, "countering");   // thought bubble: "countering…"

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
  const ok = ev.consensus_reached;
  debateStatus.textContent = ok ? "consensus ✓" : "no consensus — Judge decides";
  let html = `<div class="consensus-banner ${ok ? "yes" : "no"}">`
           + (ok ? "✓ Consensus reached" : "⚖️ No consensus — the Judge decides") + `</div>`;
  html += window.marked ? marked.parse(ev.content || "") : (ev.content || "");
  consensusEl.innerHTML = html;
  // the researchers are done countering
  ["Bull Researcher", "Bear Researcher"].forEach(hideBubble);
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

function renderVerdict(ev) {
  const rating = (ev.rating || "").toLowerCase();
  const score = ev.weighted_score;
  let html = `<h2>Judge verdict</h2>`;
  html += `<div class="rating ${rating}">${ev.rating || ev.decision || "—"}</div>`;
  if (typeof score === "number") {
    const pos = ((score + 1) / 2) * 100;
    html += `<div class="bar"><div class="mark" style="left:${pos}%"></div></div>`;
    html += `<div class="log">weighted score ${score >= 0 ? "+" : ""}${score.toFixed(2)} (−1 bearish … +1 bullish)</div>`;
  }
  if (ev.scoreboard && ev.scoreboard.length) {
    html += `<table class="scoreboard"><tr><th>Metric</th><th>Source</th><th>Value</th><th>Weight</th><th>Score</th><th>Note</th></tr>`;
    ev.scoreboard.forEach((e) => {
      html += `<tr><td>${e.metric}</td><td>${e.source}</td><td>${e.raw_value}</td>`
            + `<td>${(+e.weight).toFixed(2)}</td><td>${(+e.score >= 0 ? "+" : "")}${(+e.score).toFixed(2)}</td>`
            + `<td>${(e.note || "").replace(/</g, "&lt;")}</td></tr>`;
    });
    html += `</table>`;
  }
  verdictEl.innerHTML = html;
  verdictEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// --------------------------------------------------------------------------- //
// Run analysis (SSE)
// --------------------------------------------------------------------------- //
const runBtn = document.getElementById("run");
runBtn.addEventListener("click", startRun);

function setStatus(text) { document.getElementById("status-pill").textContent = text; }

function startRun() {
  if (!currentTicker || sse) return;
  const analysts = [...document.querySelectorAll(".analysts input:checked")].map((c) => c.value);
  if (!analysts.length) { setStatus("pick at least one analyst"); return; }
  const provider = document.getElementById("provider").value;
  const depth = document.getElementById("depth").value;
  const language = document.getElementById("language").value;

  // reset UI
  buildGraph();
  outputEl.innerHTML = "";
  verdictEl.innerHTML = "";
  resetReports();
  resetDebate();
  startTrackers();
  // Hide unselected analysts entirely — their node, bubble, AND the edges they
  // feed into the researchers — so only the chosen analysts appear and "run".
  Object.keys(NODES).forEach((n) => {
    const wanted = ANALYST_NODE[n];
    if (wanted && !analysts.includes(wanted)) {
      nodeEls[n].style.display = "none";
      if (bubbleEls[n]) bubbleEls[n].g.style.display = "none";
      Object.entries(edgeEls).forEach(([key, path]) => {
        if (key.startsWith(n + "->")) path.style.display = "none";
      });
    }
  });
  runBtn.disabled = true;
  setStatus("running…");

  const params = new URLSearchParams({
    ticker: currentTicker, analysts: analysts.join(","),
    provider, research_depth: depth, language,
  });
  sse = new EventSource(`/api/analyze?${params.toString()}`);
  sse.onmessage = (e) => handleEvent(JSON.parse(e.data));
  sse.onerror = () => { logLine("connection closed"); endRun(); };
}

const ANALYST_NODE = {
  "Market Analyst": "market", "Fundamentals Analyst": "fundamentals",
  "News Analyst": "news", "Sentiment Analyst": "social",
};

function handleEvent(ev) {
  switch (ev.type) {
    case "start":
      logLine(`Analyzing ${ev.ticker} as of ${ev.date} — analysts: ${ev.analysts.join(", ")}`);
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
      stopTrackers();
      break;
    case "error":
      logLine(`Error: ${ev.message}`);
      setStatus("error");
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
// Init
// --------------------------------------------------------------------------- //
buildGraph();
