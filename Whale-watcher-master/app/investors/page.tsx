"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { ExternalLink, AlertCircle, RefreshCw, TrendingUp, TrendingDown, BarChart2, PieChart as PieIcon, Activity, Clock } from "lucide-react";
import SymbolModal from "@/components/SymbolModal";
import { format, parseISO, formatDistanceToNow } from "date-fns";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, LabelList,
} from "recharts";

interface Holding {
  name: string; ticker: string | null; value: number; shares: number;
  pricePerShare: number; pctPortfolio: number; putCall: string; isOption: boolean;
}
interface InvestorData {
  id: string; name: string; fund: string; avatar: string;
  strategy: string; aum: string; filingDate: string;
  holdings: Holding[]; source: string; error?: string;
}
interface Quote { price: number; change: number; changePct: number }

// ── Color palettes ─────────────────────────────────────────────────────────
const PIE_COLORS = [
  "#00e5a0","#4b9eff","#f5a623","#ff3b3b","#a855f7",
  "#00d4ff","#ff8c00","#ec4899","#84cc16","#6366f1",
  "#14b8a6","#f97316","#8b5cf6","#06b6d4","#eab308",
];

const INVESTOR_BIOS: Record<string, { title: string; style: string; risk: string; bio: string; since: string }> = {
  berkshire: {
    title: "Chairman & CEO, Berkshire Hathaway",
    style: "Deep-value buy-and-hold",
    risk: "LOW",
    since: "1965",
    bio: "The 'Oracle of Omaha' focuses on buying wonderful companies at fair prices. Known for concentrated, long-duration holdings and aversion to technology — until Apple.",
  },
  burry: {
    title: "Founder, Scion Asset Management",
    style: "Deep-value / Macro short",
    risk: "HIGH",
    since: "2000",
    bio: "Made famous by 'The Big Short' for calling the 2008 housing crisis. Burry uses puts for leveraged bearish bets. High conviction, low diversification, contrarian.",
  },
  ackman: {
    title: "CEO, Pershing Square Capital",
    style: "Activist concentrated",
    risk: "MED",
    since: "2004",
    bio: "Activist investor who takes large stakes and pushes for strategic change. Known for high-profile wins (Chipotle) and losses (Valeant). Very concentrated portfolio.",
  },
  ark: {
    title: "Founder & CIO, ARK Invest",
    style: "Disruptive innovation / Growth",
    risk: "VERY HIGH",
    since: "2014",
    bio: "Cathie Wood bets on exponential technology disruption: AI, genomics, energy storage, fintech, robotics. ARKK is the flagship ETF with daily position updates.",
  },
};

// ── Formatters ─────────────────────────────────────────────────────────────
function fmtUsd(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}
function shortName(n: string) {
  return n.replace(/ INC$| CORP$| LTD$| CO$/, "").replace(/ COM$/, "").slice(0, 18);
}
function riskColor(risk: string) {
  if (risk === "LOW")       return "var(--green)";
  if (risk === "MED")       return "var(--gold)";
  if (risk === "HIGH")      return "var(--red)";
  if (risk === "VERY HIGH") return "#ff00aa";
  return "var(--text-muted)";
}

// ── Custom tooltip for charts ───────────────────────────────────────────────
function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bb-tooltip" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-light)", borderRadius: 4, padding: "8px 12px", fontSize: 11, fontFamily: "JetBrains Mono, monospace" }}>
      <p style={{ color: "var(--text-primary)", fontWeight: 700 }}>{d.name}</p>
      <p style={{ color: payload[0].color }}>
        {payload[0].name === "pctPortfolio" ? `${d.pctPortfolio.toFixed(1)}% of portfolio` : fmtUsd(d.value)}
      </p>
      {d.shares && <p style={{ color: "var(--text-muted)" }}>{d.shares.toLocaleString()} shares</p>}
    </div>
  );
}

// ── Portfolio metrics calculator ────────────────────────────────────────────
function calcMetrics(holdings: Holding[]) {
  const total = holdings.reduce((s, h) => s + h.value, 0);
  const top5pct = holdings.slice(0, 5).reduce((s, h) => s + h.pctPortfolio, 0);
  const optionsPct = holdings.filter(h => h.isOption).reduce((s, h) => s + h.pctPortfolio, 0);
  const shortPct  = holdings.filter(h => h.putCall === "Put").reduce((s, h) => s + h.pctPortfolio, 0);
  const positions  = holdings.length;
  const largest    = holdings[0];
  return { total, top5pct, optionsPct, shortPct, positions, largest };
}

// ── Holding row ─────────────────────────────────────────────────────────────
function HoldingRow({ h, quote, rank, color, onTickerClick }: { h: Holding; quote?: Quote; rank: number; color: string; onTickerClick: (t: string) => void }) {
  const isShort = h.putCall === "Put";
  const isCall  = h.putCall === "Call";
  const sentiment = isShort ? "SHORT" : isCall ? "CALL" : "LONG";
  const sentClass = isShort ? "tag-sell" : isCall ? "tag-call" : "tag-buy";

  return (
    <tr className="border-b transition-colors hover:bg-white/[0.015]" style={{ borderColor: "var(--border)" }}>
      <td className="px-3 py-2.5" style={{ width: 32 }}>
        <div className="flex items-center gap-2">
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
          <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>{rank}</span>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div>
          {h.ticker ? (
            <button
              onClick={() => onTickerClick(h.ticker!)}
              className="mono font-bold text-sm hover:underline flex items-center gap-1 text-left"
              style={{ color: "var(--green)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              {h.ticker}
            </button>
          ) : <span className="mono font-bold text-sm" style={{ color: "var(--text-muted)" }}>—</span>}
          <p className="text-xs truncate" style={{ color: "var(--text-muted)", maxWidth: 160 }}>
            {h.name.replace(/ INC$| CORP$| LTD$| CO$/, "").replace(/ COM$/, "")}
          </p>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span className={`tag ${sentClass}`}>{sentiment}</span>
      </td>
      <td className="px-3 py-2.5 text-right">
        <p className="num font-semibold text-sm" style={{ color: "var(--text-primary)" }}>{fmtUsd(h.value)}</p>
        <div className="mini-bar-track" style={{ width: 72 }}>
          <div className="mini-bar-fill" style={{
            width: `${Math.min(h.pctPortfolio * 2.5, 100)}%`,
            background: isShort ? "var(--red)" : "var(--green)",
          }} />
        </div>
      </td>
      <td className="px-3 py-2.5 text-right num text-xs font-bold" style={{ color: isShort ? "var(--red)" : color }}>
        {h.pctPortfolio.toFixed(1)}%
      </td>
      <td className="px-3 py-2.5 text-right">
        {quote ? (
          <div>
            <p className="num text-sm font-semibold" style={{ color: "var(--text-primary)" }}>${quote.price.toFixed(2)}</p>
            <p className="num text-xs" style={{ color: quote.changePct >= 0 ? "var(--green)" : "var(--red)" }}>
              {quote.changePct >= 0 ? "▲" : "▼"} {Math.abs(quote.changePct).toFixed(2)}%
            </p>
          </div>
        ) : h.pricePerShare > 0 ? (
          <div>
            <p className="num text-sm" style={{ color: "var(--text-secondary)" }}>${h.pricePerShare.toFixed(2)}</p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>at filing</p>
          </div>
        ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
      </td>
      <td className="px-3 py-2.5 text-right num text-xs" style={{ color: "var(--text-muted)" }}>
        {h.shares >= 1e6 ? `${(h.shares / 1e6).toFixed(2)}M` : h.shares.toLocaleString()}
      </td>
    </tr>
  );
}

// ── Investor selector card ──────────────────────────────────────────────────
function InvestorCard({ inv, active, onClick }: { inv: InvestorData; active: boolean; onClick: () => void }) {
  const bio = INVESTOR_BIOS[inv.id];
  return (
    <button onClick={onClick} className="w-full text-left transition-all" style={{
      background: active ? "rgba(0,229,160,0.06)" : "var(--bg-card)",
      border: `1px solid ${active ? "rgba(0,229,160,0.3)" : "var(--border)"}`,
      borderRadius: 4,
      padding: "10px 12px",
    }}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <span style={{ fontSize: 20 }}>{inv.avatar}</span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate" style={{ color: "var(--text-primary)" }}>{inv.name}</p>
          <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>{inv.fund}</p>
        </div>
        {inv.error && <AlertCircle size={12} style={{ color: "var(--gold)" }} />}
      </div>
      <div className="flex items-center justify-between">
        <span className="num font-bold text-sm" style={{ color: active ? "var(--green)" : "var(--text-primary)" }}>
          {inv.aum}
        </span>
        {bio && (
          <span className="mono text-xs px-1.5 py-0.5 rounded" style={{
            background: riskColor(bio.risk) + "18",
            color: riskColor(bio.risk),
            fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
          }}>
            {bio.risk} RISK
          </span>
        )}
      </div>
      {inv.filingDate && inv.filingDate !== "unavailable" && (
        <p className="mono text-xs mt-1" style={{ color: "var(--text-muted)" }}>
          {inv.source} · {(() => { try { return format(parseISO(inv.filingDate), "MMM d, yyyy"); } catch { return inv.filingDate; } })()}
        </p>
      )}
    </button>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function InvestorsPage() {
  const [investors, setInvestors] = useState<Record<string, InvestorData>>({});
  const [selectedId, setSelectedId] = useState("berkshire");
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [loading, setLoading] = useState(true);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "holdings">("overview");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  const fetchInvestors = useCallback(() => {
    fetch("/api/investors")
      .then(r => r.json())
      .then(d => { setInvestors(d); setLastUpdate(new Date()); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchInvestors();
    const iv = setInterval(fetchInvestors, 30000); // refresh every 30s (EDGAR data doesn't change faster)
    return () => clearInterval(iv);
  }, [fetchInvestors]);

  const selected = investors[selectedId];
  const bio = INVESTOR_BIOS[selectedId];

  useEffect(() => {
    if (!selected?.holdings?.length) return;
    const tickers = selected.holdings.map(h => h.ticker).filter(Boolean).slice(0, 20) as string[];
    if (!tickers.length) return;
    setQuotesLoading(true);
    const fetchQ = () => {
      fetch(`/api/stocks?tickers=${tickers.join(",")}`)
        .then(r => r.json())
        .then(d => { setQuotes(d.quotes ?? {}); })
        .finally(() => setQuotesLoading(false));
    };
    fetchQ();
    const iv = setInterval(fetchQ, 1000);
    return () => clearInterval(iv);
  }, [selected]);

  const metrics = useMemo(() => selected?.holdings ? calcMetrics(selected.holdings) : null, [selected]);

  const pieData = useMemo(() => {
    if (!selected?.holdings) return [];
    const top9 = selected.holdings.slice(0, 9);
    const rest = selected.holdings.slice(9).reduce((s, h) => s + h.pctPortfolio, 0);
    const data = top9.map(h => ({ name: shortName(h.name), pctPortfolio: h.pctPortfolio, value: h.value, shares: h.shares, isShort: h.putCall === "Put" }));
    if (rest > 0) data.push({ name: "Other", pctPortfolio: Math.round(rest * 10) / 10, value: 0, shares: 0, isShort: false });
    return data;
  }, [selected]);

  const barData = useMemo(() => {
    if (!selected?.holdings) return [];
    return selected.holdings.slice(0, 12).map(h => ({
      name: h.ticker ?? shortName(h.name),
      pctPortfolio: h.pctPortfolio,
      value: h.value,
      shares: h.shares,
      isShort: h.putCall === "Put",
    }));
  }, [selected]);

  const ORDER = ["berkshire", "burry", "ackman", "ark"];

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1400, margin: "0 auto" }}>
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="gradient-text font-bold mb-0.5" style={{ fontSize: 22 }}>Famous Investors</h1>
          <p className="mono text-xs" style={{ color: "var(--text-muted)" }}>
            SEC EDGAR 13F · ARK daily holdings · Live Yahoo Finance prices
          </p>
        </div>
        <div className="flex items-center gap-3">
          {quotesLoading && (
            <div className="flex items-center gap-1.5 mono text-xs" style={{ color: "var(--gold)" }}>
              <Activity size={11} className="animate-pulse" /> LIVE PRICES
            </div>
          )}
          {lastUpdate && (
            <div className="mono text-xs" style={{ color: "var(--text-muted)" }}>
              Updated {formatDistanceToNow(lastUpdate, { addSuffix: true })}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 16 }}>
        {/* ── Investor selector ────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {loading ? Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, height: 80, animation: "pulse 2s infinite" }} />
          )) : ORDER.map(id => investors[id] && (
            <InvestorCard key={id} inv={investors[id]} active={selectedId === id} onClick={() => { setSelectedId(id); setActiveTab("overview"); }} />
          ))}

          <div style={{ marginTop: 8, padding: "10px 12px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4 }}>
            <p className="mono text-xs mb-2" style={{ color: "var(--text-muted)", letterSpacing: "0.08em" }}>DATA SOURCES</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {[
                { src: "SEC EDGAR", desc: "13F filings" },
                { src: "arkfunds.io", desc: "Daily holdings" },
                { src: "Yahoo Finance", desc: "Live prices" },
              ].map(s => (
                <div key={s.src} className="flex items-center gap-1.5">
                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--green)" }} />
                  <div>
                    <span className="mono text-xs" style={{ color: "var(--text-primary)" }}>{s.src}</span>
                    <span className="mono text-xs" style={{ color: "var(--text-muted)" }}> · {s.desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Detail panel ─────────────────────────────────────────────── */}
        {loading || !selected ? (
          <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 400 }}>
            <div style={{ textAlign: "center", color: "var(--text-muted)" }}>
              <RefreshCw size={22} className="animate-spin" style={{ color: "var(--green)", margin: "0 auto 10px" }} />
              <p className="mono text-xs">FETCHING SEC EDGAR DATA…</p>
            </div>
          </div>
        ) : selected.error ? (
          <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 400 }}>
            <div style={{ textAlign: "center" }}>
              <AlertCircle size={22} style={{ color: "var(--gold)", margin: "0 auto 10px" }} />
              <p className="mono text-xs" style={{ color: "var(--text-muted)" }}>{selected.error}</p>
            </div>
          </div>
        ) : (
          <div>
            {/* ── Investor header ───────────────────────────────────── */}
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, marginBottom: 12 }}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div className="flex items-center gap-4">
                  <span style={{ fontSize: 36 }}>{selected.avatar}</span>
                  <div>
                    <h2 className="font-bold" style={{ fontSize: 18, color: "var(--text-primary)", marginBottom: 2 }}>{selected.name}</h2>
                    <p className="mono text-xs" style={{ color: "var(--text-muted)" }}>{bio?.title}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="mono text-xs" style={{ color: "var(--text-secondary)" }}>{selected.fund}</span>
                      {bio && (
                        <span className="mono px-1.5 py-0.5" style={{
                          background: riskColor(bio.risk) + "18", color: riskColor(bio.risk),
                          fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", borderRadius: 3,
                        }}>{bio.risk} RISK</span>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <p className="stat-label">Portfolio AUM</p>
                  <p className="num font-bold" style={{ fontSize: 26, color: "var(--green)" }}>{selected.aum}</p>
                  <p className="mono text-xs" style={{ color: "var(--text-muted)" }}>
                    {selected.source} · {(() => { try { return format(parseISO(selected.filingDate), "MMM d, yyyy"); } catch { return selected.filingDate; } })()}
                  </p>
                </div>
              </div>
              {bio && (
                <div style={{ padding: "10px 18px", background: "var(--bg-secondary)" }}>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>{bio.bio}</p>
                  <div className="flex gap-6 mt-2">
                    <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>Style: <span style={{ color: "var(--text-secondary)" }}>{bio.style}</span></span>
                    <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>Active since: <span style={{ color: "var(--text-secondary)" }}>{bio.since}</span></span>
                  </div>
                </div>
              )}
            </div>

            {/* ── Key metrics ──────────────────────────────────────── */}
            {metrics && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 12 }}>
                {[
                  { label: "POSITIONS", value: metrics.positions.toString(), sub: "total holdings" },
                  { label: "TOP-5 CONC.", value: `${metrics.top5pct.toFixed(1)}%`, sub: "of portfolio", color: metrics.top5pct > 70 ? "var(--gold)" : "var(--green)" },
                  { label: "LARGEST POS.", value: metrics.largest ? `${metrics.largest.pctPortfolio.toFixed(1)}%` : "—", sub: metrics.largest ? (metrics.largest.ticker ?? shortName(metrics.largest.name)) : "", color: "var(--text-primary)" },
                  { label: "OPTIONS EXP.", value: `${metrics.optionsPct.toFixed(1)}%`, sub: "puts + calls", color: metrics.optionsPct > 0 ? "var(--gold)" : "var(--text-muted)" },
                  { label: "SHORT EXP.", value: `${metrics.shortPct.toFixed(1)}%`, sub: "put options", color: metrics.shortPct > 0 ? "var(--red)" : "var(--text-muted)" },
                ].map(m => (
                  <div key={m.label} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "10px 12px" }}>
                    <p className="stat-label" style={{ marginBottom: 4 }}>{m.label}</p>
                    <p className="num font-bold" style={{ fontSize: 18, color: m.color ?? "var(--text-primary)" }}>{m.value}</p>
                    <p className="mono text-xs" style={{ color: "var(--text-muted)", marginTop: 2 }}>{m.sub}</p>
                  </div>
                ))}
              </div>
            )}

            {/* ── Tabs ─────────────────────────────────────────────── */}
            <div className="flex gap-1 mb-3">
              {(["overview", "holdings"] as const).map(t => (
                <button key={t} onClick={() => setActiveTab(t)} className="mono text-xs px-3 py-1.5 transition-all" style={{
                  borderRadius: 3, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
                  background: activeTab === t ? "rgba(0,229,160,0.12)" : "var(--bg-card)",
                  border: `1px solid ${activeTab === t ? "rgba(0,229,160,0.3)" : "var(--border)"}`,
                  color: activeTab === t ? "var(--green)" : "var(--text-muted)",
                }}>
                  {t === "overview" ? <><PieIcon size={10} style={{ display: "inline", marginRight: 4 }} />Overview</> : <><BarChart2 size={10} style={{ display: "inline", marginRight: 4 }} />All Holdings</>}
                </button>
              ))}
              {selected.id === "burry" && (
                <span className="mono text-xs px-3 py-1.5 ml-2" style={{
                  color: "var(--red)", background: "var(--red-dim)",
                  border: "1px solid rgba(255,59,59,0.2)", borderRadius: 3, fontWeight: 700,
                }}>
                  ⚠ PUTS = BEARISH SHORT BETS
                </span>
              )}
            </div>

            {/* ── Overview tab: charts ─────────────────────────────── */}
            {activeTab === "overview" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {/* Pie chart */}
                <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
                  <div className="bb-header">Portfolio Allocation</div>
                  <div style={{ padding: "12px 8px" }}>
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie
                          data={pieData}
                          dataKey="pctPortfolio"
                          nameKey="name"
                          cx="50%" cy="50%"
                          innerRadius={55}
                          outerRadius={95}
                          paddingAngle={2}
                        >
                          {pieData.map((d, i) => (
                            <Cell key={i} fill={d.isShort ? "#ff3b3b" : PIE_COLORS[i % PIE_COLORS.length]} stroke="var(--bg-primary)" strokeWidth={1} />
                          ))}
                        </Pie>
                        <Tooltip content={<ChartTooltip />} />
                        <Legend
                          iconType="circle"
                          iconSize={7}
                          formatter={(v) => <span style={{ fontSize: 10, fontFamily: "JetBrains Mono", color: "var(--text-secondary)" }}>{v}</span>}
                          wrapperStyle={{ paddingTop: 8, fontSize: 10 }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Bar chart */}
                <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
                  <div className="bb-header">Top Positions — % of Portfolio</div>
                  <div style={{ padding: "12px 4px 8px" }}>
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={barData} layout="vertical" margin={{ left: 0, right: 32, top: 4, bottom: 4 }}>
                        <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="2 4" />
                        <XAxis type="number" tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "var(--text-muted)" }}
                          tickFormatter={v => `${v}%`} axisLine={false} tickLine={false} />
                        <YAxis type="category" dataKey="name" width={52}
                          tick={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "var(--text-secondary)" }}
                          axisLine={false} tickLine={false} />
                        <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
                        <Bar dataKey="pctPortfolio" radius={[0, 2, 2, 0]}>
                          {barData.map((d, i) => (
                            <Cell key={i} fill={d.isShort ? "#ff3b3b" : PIE_COLORS[i % PIE_COLORS.length]} />
                          ))}
                          <LabelList dataKey="pctPortfolio" position="right"
                            style={{ fontSize: 9, fontFamily: "JetBrains Mono", fill: "var(--text-muted)" }}
                            formatter={(v: number) => `${v.toFixed(1)}%`} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}

            {/* ── Holdings tab: full table ──────────────────────────── */}
            {activeTab === "holdings" && (
              <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
                <div className="bb-header flex items-center justify-between" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>All Holdings — {selected.holdings.length} positions</span>
                  {quotesLoading && <span style={{ color: "var(--gold)", fontSize: 9 }}>● LIVE PRICES UPDATING</span>}
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="w-full" style={{ borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-secondary)" }}>
                        {["#", "Position", "Type", "Value", "% Port.", "Live Price", "Shares"].map((h, i) => (
                          <th key={h} className="mono px-3 py-2.5" style={{
                            fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase",
                            color: "var(--text-muted)", textAlign: i >= 3 ? "right" : "left",
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {selected.holdings.map((h, i) => (
                        <HoldingRow key={`${h.name}-${h.putCall}`} h={h}
                          quote={h.ticker ? quotes[h.ticker] : undefined}
                          rank={i + 1}
                          color={PIE_COLORS[i % PIE_COLORS.length]}
                          onTickerClick={setSelectedTicker} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mono" style={{ padding: "8px 14px", borderTop: "1px solid var(--border)", fontSize: 10, color: "var(--text-muted)", display: "flex", justifyContent: "space-between" }}>
                  <span>{selected.holdings.length} positions · Data: {selected.source}</span>
                  <span>Prices: Yahoo Finance · {quotesLoading ? "Refreshing…" : "1s auto-refresh"}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedTicker && (
        <SymbolModal ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />
      )}
    </div>
  );
}
