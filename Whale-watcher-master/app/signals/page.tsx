"use client";
import { useState, useEffect } from "react";
import { RefreshCw, Zap, TrendingUp, TrendingDown, Target, Shield } from "lucide-react";
import SymbolModal from "@/components/SymbolModal";

interface SignalResult {
  ticker: string;
  score: number;
  rating: "STRONG BUY" | "BUY" | "WATCH" | "NEUTRAL" | "CAUTION" | "AVOID";
  entryPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  stopPct: number;
  targetPct: number;
  riskReward: number;
  signals: {
    congressBuys: number;
    congressSells: number;
    insiderBuys: number;
    insiderSells: number;
    callsVsPuts: string;
    fearGreed: number;
  };
  contributors: string[];
}

interface SignalsData {
  signals: SignalResult[];
  fearGreed: number;
  insiderCount: number;
  lastUpdated: string;
}

const RATING_CONFIG = {
  "STRONG BUY": { color: "#00e5a0", bg: "rgba(0,229,160,0.12)", border: "rgba(0,229,160,0.35)", icon: "🟢" },
  "BUY":        { color: "#4b9eff", bg: "rgba(75,158,255,0.10)", border: "rgba(75,158,255,0.3)", icon: "🔵" },
  "WATCH":      { color: "#f5a623", bg: "rgba(245,166,35,0.10)", border: "rgba(245,166,35,0.3)", icon: "🟡" },
  "NEUTRAL":    { color: "#94a3b8", bg: "rgba(148,163,184,0.08)", border: "rgba(148,163,184,0.2)", icon: "⚪" },
  "CAUTION":    { color: "#f97316", bg: "rgba(249,115,22,0.10)", border: "rgba(249,115,22,0.3)", icon: "🟠" },
  "AVOID":      { color: "#ff3b3b", bg: "rgba(255,59,59,0.12)", border: "rgba(255,59,59,0.3)", icon: "🔴" },
};

function ScoreBar({ score }: { score: number }) {
  // score: -6 to +10, center at 0
  const pct = Math.max(0, Math.min(100, ((score + 6) / 16) * 100));
  const color = score >= 7 ? "#00e5a0" : score >= 4 ? "#4b9eff" : score >= 1 ? "#f5a623" : score >= -1 ? "#94a3b8" : "#ff3b3b";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 100, height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden", position: "relative" }}>
        <div style={{ position: "absolute", left: "37.5%", top: 0, bottom: 0, width: 1, background: "#374f68" }} />
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.4s" }} />
      </div>
      <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontWeight: 700, color, minWidth: 24 }}>
        {score > 0 ? `+${score}` : score}
      </span>
    </div>
  );
}

function SignalCard({ s, onTickerClick }: { s: SignalResult; onTickerClick: (t: string) => void }) {
  const cfg = RATING_CONFIG[s.rating];
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      background: "var(--bg-card)", border: `1px solid ${cfg.border}`,
      borderRadius: 6, marginBottom: 8, overflow: "hidden",
      transition: "border-color 0.15s",
    }}>
      {/* Main row */}
      <div style={{ display: "grid", gridTemplateColumns: "120px 140px 1fr 180px 180px 180px 100px", alignItems: "center", padding: "14px 16px", gap: 12, cursor: "pointer" }}
        onClick={() => setExpanded(e => !e)}>
        {/* Ticker */}
        <div>
          <button onClick={e => { e.stopPropagation(); onTickerClick(s.ticker); }} style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 18, fontWeight: 700,
            color: cfg.color, background: cfg.bg,
            border: `1px solid ${cfg.border}`, borderRadius: 4,
            padding: "4px 12px", cursor: "pointer", display: "block",
          }}>{s.ticker}</button>
        </div>

        {/* Rating badge */}
        <div>
          <span style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
            letterSpacing: "0.06em", padding: "4px 10px", borderRadius: 4,
            background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
            display: "inline-block",
          }}>{cfg.icon} {s.rating}</span>
        </div>

        {/* Score bar */}
        <ScoreBar score={s.score} />

        {/* Entry */}
        <div>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: 2 }}>ENTRY</p>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
            {s.entryPrice ? `$${s.entryPrice.toFixed(2)}` : "—"}
          </p>
        </div>

        {/* Stop loss */}
        <div>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: 2 }}>STOP LOSS</p>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 14, fontWeight: 700, color: "#ff3b3b" }}>
            {s.stopLoss ? `$${s.stopLoss.toFixed(2)}` : "—"}
            {s.stopPct > 0 && <span style={{ fontSize: 9, marginLeft: 4, color: "#ff3b3b88" }}>(-{s.stopPct}%)</span>}
          </p>
        </div>

        {/* Target */}
        <div>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: 2 }}>TARGET</p>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 14, fontWeight: 700, color: "#00e5a0" }}>
            {s.target ? `$${s.target.toFixed(2)}` : "—"}
            {s.targetPct > 0 && <span style={{ fontSize: 9, marginLeft: 4, color: "#00e5a088" }}>(+{s.targetPct}%)</span>}
          </p>
        </div>

        {/* R:R */}
        <div style={{ textAlign: "right" }}>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: 2 }}>RISK/REWARD</p>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 14, fontWeight: 700, color: s.riskReward >= 3 ? "#00e5a0" : s.riskReward >= 2 ? "#4b9eff" : "#94a3b8" }}>
            1:{s.riskReward}
          </p>
        </div>
      </div>

      {/* Expanded signal breakdown */}
      {expanded && (
        <div style={{ padding: "12px 16px 14px", borderTop: "1px solid var(--border)", background: "rgba(0,0,0,0.2)" }}>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: 10 }}>SIGNAL BREAKDOWN</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            {[
              { label: "Congress Buys", value: s.signals.congressBuys, color: "#00e5a0", show: s.signals.congressBuys > 0 },
              { label: "Congress Sells", value: s.signals.congressSells, color: "#ff3b3b", show: s.signals.congressSells > 0 },
              { label: "Insider Buying", value: "✓", color: "#f5a623", show: s.signals.insiderBuys > 0 },
              { label: "Fear & Greed", value: s.signals.fearGreed, color: "#94a3b8", show: true },
            ].filter(x => x.show).map(x => (
              <div key={x.label} style={{
                fontFamily: "JetBrains Mono,monospace", fontSize: 10,
                padding: "4px 10px", borderRadius: 3,
                background: `${x.color}12`, border: `1px solid ${x.color}30`,
                color: x.color,
              }}>
                {x.label}: <strong>{x.value}</strong>
              </div>
            ))}
          </div>
          {s.contributors.length > 0 && (
            <p style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              {s.contributors.join("  ·  ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function SignalsPage() {
  const [data, setData] = useState<SignalsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "STRONG BUY" | "BUY" | "WATCH" | "AVOID">("all");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  const fetchSignals = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/signals");
      const d = await res.json();
      setData(d);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchSignals(); }, []);

  const displayed = filter === "all"
    ? data?.signals ?? []
    : data?.signals.filter(s => s.rating === filter) ?? [];

  const counts = {
    "STRONG BUY": data?.signals.filter(s => s.rating === "STRONG BUY").length ?? 0,
    "BUY":        data?.signals.filter(s => s.rating === "BUY").length ?? 0,
    "WATCH":      data?.signals.filter(s => s.rating === "WATCH").length ?? 0,
    "AVOID":      data?.signals.filter(s => s.rating === "AVOID" || s.rating === "CAUTION").length ?? 0,
  };

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1400, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="gradient-text font-bold" style={{ fontSize: 22, marginBottom: 3, display: "flex", alignItems: "center", gap: 8 }}>
            <Zap size={20} style={{ color: "#f5a623" }} /> Signal Engine
          </h1>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
            Congress · Insiders · Fear &amp; Greed · Entry/Stop/Target — smart money confluence
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {data?.lastUpdated && (
            <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)" }}>
              {new Date(data.lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <button onClick={fetchSignals} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 10px", cursor: "pointer", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* How it works */}
      <div style={{ background: "rgba(245,166,35,0.06)", border: "1px solid rgba(245,166,35,0.2)", borderRadius: 4, padding: "10px 16px", marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7, margin: 0 }}>
          <span style={{ color: "#f5a623", fontWeight: 700, fontFamily: "JetBrains Mono,monospace", fontSize: 10 }}>HOW SIGNALS WORK: </span>
          Each ticker is scored across Congress trades (last 60 days), corporate insider buying, and Fear &amp; Greed sentiment.
          Score ≥7 = STRONG BUY. Entry is the current market price. Stop loss and target are calculated from the signal strength.
          <strong style={{ color: "#ff3b3b" }}> This is not financial advice — always do your own research.</strong>
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {([
          { label: "STRONG BUY", key: "STRONG BUY" as const, color: "#00e5a0" },
          { label: "BUY", key: "BUY" as const, color: "#4b9eff" },
          { label: "WATCH", key: "WATCH" as const, color: "#f5a623" },
          { label: "AVOID/CAUTION", key: "AVOID" as const, color: "#ff3b3b" },
        ]).map(s => (
          <div key={s.key} style={{ background: "var(--bg-card)", border: `1px solid ${s.color}30`, borderRadius: 4, padding: "8px 16px", cursor: "pointer" }}
            onClick={() => setFilter(filter === s.key ? "all" : s.key)}>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginBottom: 3, letterSpacing: "0.08em" }}>{s.label}</p>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 22, fontWeight: 700, color: s.color }}>{counts[s.key]}</p>
          </div>
        ))}
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "8px 16px" }}>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginBottom: 3, letterSpacing: "0.08em" }}>FEAR &amp; GREED</p>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 22, fontWeight: 700, color: (data?.fearGreed ?? 50) < 30 ? "#00e5a0" : (data?.fearGreed ?? 50) > 70 ? "#ff3b3b" : "#94a3b8" }}>
            {data?.fearGreed ?? "—"}
          </p>
        </div>
      </div>

      {/* Column headers */}
      {!loading && displayed.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "120px 140px 1fr 180px 180px 180px 100px", padding: "6px 16px", gap: 12, marginBottom: 4 }}>
          {["TICKER", "SIGNAL", "SCORE", "ENTRY", "STOP LOSS", "TARGET", "R/R"].map(h => (
            <span key={h} style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-muted)" }}>{h}</span>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 80, gap: 12, flexDirection: "column" }}>
          <RefreshCw size={20} className="animate-spin" style={{ color: "#00e5a0" }} />
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 12, color: "var(--text-muted)" }}>
            Scanning Congress trades, insider filings, market sentiment…
          </span>
        </div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)", fontFamily: "JetBrains Mono,monospace", fontSize: 12 }}>
          No signals match the current filter.
        </div>
      ) : (
        displayed.map(s => <SignalCard key={s.ticker} s={s} onTickerClick={setSelectedTicker} />)
      )}

      <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginTop: 16 }}>
        Signals based on public disclosures only · Past performance ≠ future results · Not financial advice · Always DYOR
      </p>

      {selectedTicker && <SymbolModal ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />}
    </div>
  );
}
