"use client";
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Search } from "lucide-react";
import SymbolModal from "@/components/SymbolModal";

interface DarkPoolEntry {
  symbol: string;
  shortVolume: number;
  totalVolume: number;
  shortPct: number;
  darkPoolPct: number;
  signal: "bullish" | "bearish" | "neutral";
  date: string;
}

interface DarkPoolData {
  entries: DarkPoolEntry[];
  bullish: DarkPoolEntry[];
  bearish: DarkPoolEntry[];
  date: string;
  ticker: string | null;
}

function fmtVol(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
}

function SignalBadge({ signal }: { signal: "bullish" | "bearish" | "neutral" }) {
  const cfg = {
    bullish: { color: "#00e5a0", bg: "rgba(0,229,160,0.12)", border: "rgba(0,229,160,0.3)", label: "▲ BULLISH" },
    bearish: { color: "#ff3b3b", bg: "rgba(255,59,59,0.12)", border: "rgba(255,59,59,0.3)", label: "▼ BEARISH" },
    neutral: { color: "#94a3b8", bg: "rgba(148,163,184,0.08)", border: "rgba(148,163,184,0.2)", label: "◆ NEUTRAL" },
  }[signal];
  return (
    <span style={{
      fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
      padding: "2px 8px", borderRadius: 3,
      background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
    }}>{cfg.label}</span>
  );
}

function ShortBar({ pct }: { pct: number }) {
  const color = pct < 32 ? "#00e5a0" : pct > 50 ? "#ff3b3b" : "#94a3b8";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 80, height: 5, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.3s" }} />
      </div>
      <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700, color }}>{pct.toFixed(1)}%</span>
    </div>
  );
}

export default function DarkPoolPage() {
  const [data, setData] = useState<DarkPoolData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"all" | "bullish" | "bearish">("all");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [tickerInput, setTickerInput] = useState("");
  const [searchedTicker, setSearchedTicker] = useState("");

  const fetchData = useCallback(async (ticker?: string) => {
    setLoading(true);
    try {
      const url = ticker ? `/api/darkpool?ticker=${ticker}` : "/api/darkpool";
      const res = await fetch(url);
      const d = await res.json();
      setData(d);
      setLastUpdate(new Date());
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const t = tickerInput.toUpperCase().trim();
    setSearchedTicker(t);
    if (t) fetchData(t); else fetchData();
  };

  const clearSearch = () => {
    setTickerInput("");
    setSearchedTicker("");
    fetchData();
  };

  const entries = tab === "bullish" ? data?.bullish
    : tab === "bearish" ? data?.bearish
    : data?.entries ?? [];

  const bullishCount = data?.bullish.length ?? 0;
  const bearishCount = data?.bearish.length ?? 0;
  const neutralCount = (data?.entries.length ?? 0) - bullishCount - bearishCount;

  const dateLabel = data?.date === "mock" ? "Sample data"
    : data?.date ? `${data.date.slice(0, 4)}-${data.date.slice(4, 6)}-${data.date.slice(6, 8)}`
    : "";

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="gradient-text font-bold" style={{ fontSize: 22, marginBottom: 3 }}>Dark Pool Flow</h1>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
            FINRA Reg SHO · All US equities · Institutional volume · {dateLabel}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* Ticker search */}
          <form onSubmit={handleSearch} style={{ display: "flex", gap: 6 }}>
            <div style={{ position: "relative" }}>
              <Search size={12} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
              <input
                value={tickerInput}
                onChange={e => setTickerInput(e.target.value.toUpperCase())}
                placeholder="Any ticker…"
                style={{
                  fontFamily: "JetBrains Mono,monospace", fontSize: 12, fontWeight: 700,
                  background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4,
                  color: "var(--text-primary)", padding: "7px 12px 7px 28px", width: 130,
                  outline: "none",
                }}
              />
            </div>
            <button type="submit" style={{
              fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
              background: "rgba(0,229,160,0.12)", border: "1px solid rgba(0,229,160,0.3)",
              borderRadius: 4, padding: "7px 12px", cursor: "pointer", color: "#00e5a0",
            }}>SCAN</button>
            {searchedTicker && (
              <button type="button" onClick={clearSearch} style={{
                fontFamily: "JetBrains Mono,monospace", fontSize: 10,
                background: "var(--bg-card)", border: "1px solid var(--border)",
                borderRadius: 4, padding: "7px 10px", cursor: "pointer", color: "var(--text-muted)",
              }}>✕ ALL</button>
            )}
          </form>
          {lastUpdate && <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)" }}>{lastUpdate.toLocaleTimeString()}</span>}
          <button onClick={() => fetchData(searchedTicker || undefined)} style={{
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4,
            padding: "6px 10px", cursor: "pointer", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4,
          }}>
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* Active search banner */}
      {searchedTicker && (
        <div style={{ background: "rgba(0,229,160,0.06)", border: "1px solid rgba(0,229,160,0.2)", borderRadius: 4, padding: "8px 16px", marginBottom: 12 }}>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "#00e5a0", margin: 0 }}>
            Showing FINRA Reg SHO data for: <strong>{searchedTicker}</strong>
          </p>
        </div>
      )}

      {/* Explainer */}
      <div style={{ background: "rgba(75,158,255,0.06)", border: "1px solid rgba(75,158,255,0.2)", borderRadius: 4, padding: "10px 16px", marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7, margin: 0 }}>
          <span style={{ color: "#4b9eff", fontWeight: 700, fontFamily: "JetBrains Mono,monospace", fontSize: 10 }}>HOW TO READ: </span>
          <strong style={{ color: "#00e5a0" }}>Low short % (&lt;32%)</strong> = institutions buying in dark pools (bullish accumulation).{" "}
          <strong style={{ color: "#ff3b3b" }}>High short % (&gt;50%)</strong> = heavy selling / shorting (bearish distribution).
          Covers <strong style={{ color: "var(--text-primary)" }}>every US-listed stock</strong> — search any ticker above.
        </p>
      </div>

      {/* Stats */}
      {data && !searchedTicker && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          {[
            { label: "BULLISH SIGNALS", value: bullishCount, color: "#00e5a0" },
            { label: "BEARISH SIGNALS", value: bearishCount, color: "#ff3b3b" },
            { label: "NEUTRAL", value: neutralCount, color: "#94a3b8" },
            { label: "TICKERS TRACKED", value: data.entries.length, color: "var(--text-secondary)" },
          ].map(s => (
            <div key={s.label} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "8px 16px" }}>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginBottom: 3, letterSpacing: "0.08em" }}>{s.label}</p>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Tabs (hide when searching single ticker) */}
      {!searchedTicker && (
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {([
            { key: "all", label: "All Tickers" },
            { key: "bullish", label: "▲ Bullish Flow" },
            { key: "bearish", label: "▼ Bearish Flow" },
          ] as const).map(({ key, label }) => {
            const colors = { all: "#94a3b8", bullish: "#00e5a0", bearish: "#ff3b3b" };
            const c = colors[key];
            return (
              <button key={key} onClick={() => setTab(key)} style={{
                fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
                letterSpacing: "0.06em", padding: "5px 16px", borderRadius: 3, cursor: "pointer",
                background: tab === key ? `${c}18` : "var(--bg-card)",
                border: `1px solid ${tab === key ? `${c}44` : "var(--border)"}`,
                color: tab === key ? c : "var(--text-muted)",
              }}>{label}</button>
            );
          })}
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60, gap: 10 }}>
          <RefreshCw size={14} className="animate-spin" style={{ color: "#00e5a0" }} />
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 12, color: "var(--text-muted)" }}>
            {searchedTicker ? `Scanning FINRA file for ${searchedTicker}…` : "Loading FINRA data…"}
          </span>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["TICKER", "SIGNAL", "SHORT % (DARK POOL PROXY)", "SHORT VOL", "TOTAL VOL", "DARK POOL EST"].map(h => (
                  <th key={h} style={{
                    fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
                    letterSpacing: "0.08em", color: "var(--text-muted)", textAlign: "left",
                    padding: "8px 14px", whiteSpace: "nowrap",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(entries ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 40, textAlign: "center", fontFamily: "JetBrains Mono,monospace", fontSize: 12, color: "var(--text-muted)" }}>
                    {searchedTicker ? `No FINRA data found for ${searchedTicker} — may be too thinly traded or delisted.` : "No data available."}
                  </td>
                </tr>
              ) : (entries ?? []).map((e, i) => (
                <tr key={i}
                  style={{ borderBottom: "1px solid var(--border)" }}
                  onMouseEnter={ev => (ev.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                  onMouseLeave={ev => (ev.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "10px 14px" }}>
                    <button onClick={() => setSelectedTicker(e.symbol)} style={{
                      fontFamily: "JetBrains Mono,monospace", fontSize: 13, fontWeight: 700,
                      color: "#00e5a0", background: "rgba(0,229,160,0.08)",
                      border: "1px solid rgba(0,229,160,0.25)", borderRadius: 3,
                      padding: "2px 10px", cursor: "pointer",
                    }}>{e.symbol}</button>
                  </td>
                  <td style={{ padding: "10px 14px" }}><SignalBadge signal={e.signal} /></td>
                  <td style={{ padding: "10px 14px" }}><ShortBar pct={e.shortPct} /></td>
                  <td style={{ padding: "10px 14px", fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>{fmtVol(e.shortVolume)}</td>
                  <td style={{ padding: "10px 14px", fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-secondary)", fontWeight: 600 }}>{fmtVol(e.totalVolume)}</td>
                  <td style={{ padding: "10px 14px" }}>
                    <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 12, fontWeight: 700, color: e.darkPoolPct > 60 ? "#4b9eff" : "var(--text-muted)" }}>
                      ~{e.darkPoolPct.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginTop: 16 }}>
        Source: FINRA Reg SHO · Top 150 US equities by volume · Search any ticker · Not financial advice
      </p>

      {selectedTicker && <SymbolModal ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />}
    </div>
  );
}
