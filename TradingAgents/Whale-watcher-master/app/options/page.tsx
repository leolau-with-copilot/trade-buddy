"use client";
import { useState, useEffect, useCallback } from "react";
import { Search, RefreshCw, TrendingUp, TrendingDown, Zap } from "lucide-react";
import SymbolModal from "@/components/SymbolModal";

interface Contract {
  type: "call" | "put";
  contractSymbol: string;
  strike: number;
  expiration: string;
  daysToExp: number;
  lastPrice: number;
  bid: number;
  ask: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  inTheMoney: boolean;
  premium: number;
  volOiRatio: number;
  unusual: boolean;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}

interface OptionsData {
  calls: Contract[];
  puts: Contract[];
  putCallRatio: number;
  totalCallVol: number;
  totalPutVol: number;
  quote: { price: number; change: number; changePct: number; symbol: string } | null;
  expirations: string[];
  demo?: boolean;
  source?: string;
}

const DEFAULT_TICKERS = ["SPY", "QQQ", "NVDA", "AAPL", "TSLA", "MSFT", "META", "AMZN"];

function fmtNum(n: number | undefined | null) {
  if (n == null || isNaN(n as number)) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
}

function fmtPremium(n: number | undefined | null) {
  if (n == null || isNaN(n as number)) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function ContractRow({ c, onClick }: { c: Contract; onClick: () => void }) {
  const isCall = c.type === "call";
  const color = isCall ? "#00e5a0" : "#ff3b3b";
  const ivPct = (c.impliedVolatility * 100).toFixed(0);

  return (
    <tr
      style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}
      onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      <td style={{ padding: "9px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
            padding: "2px 6px", borderRadius: 3,
            background: `${color}18`, color, border: `1px solid ${color}33`,
          }}>{c.type.toUpperCase()}</span>
          {c.unusual && (
            <span style={{
              fontFamily: "JetBrains Mono,monospace", fontSize: 8, fontWeight: 700,
              padding: "1px 5px", borderRadius: 3,
              background: "rgba(245,166,35,0.15)", color: "#f5a623", border: "1px solid rgba(245,166,35,0.3)",
            }}>⚡ UNUSUAL</span>
          )}
        </div>
      </td>
      <td style={{ padding: "9px 10px", fontFamily: "JetBrains Mono,monospace", fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>
        ${c.strike.toFixed(0)}
        <span style={{ marginLeft: 5, fontSize: 9, color: c.inTheMoney ? "#00e5a0" : "#374f68", fontWeight: 400 }}>
          {c.inTheMoney ? "ITM" : "OTM"}
        </span>
      </td>
      <td style={{ padding: "9px 10px", fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
        {c.expiration}
        <span style={{ marginLeft: 6, fontSize: 9, color: c.daysToExp <= 7 ? "#ff3b3b" : "#374f68" }}>{c.daysToExp}d</span>
      </td>
      <td style={{ padding: "9px 10px", fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-primary)", fontWeight: 600 }}>
        ${c.lastPrice.toFixed(2)}
      </td>
      <td style={{ padding: "9px 10px" }}>
        <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 12, fontWeight: 700, color }}>
          {fmtPremium(c.premium)}
        </span>
      </td>
      <td style={{ padding: "9px 10px", fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-secondary)" }}>
        {fmtNum(c.volume)}
      </td>
      <td style={{ padding: "9px 10px", fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
        {fmtNum(c.openInterest)}
      </td>
      <td style={{ padding: "9px 10px" }}>
        <span style={{
          fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontWeight: 700,
          color: c.volOiRatio > 1 ? "#f5a623" : c.volOiRatio > 0.5 ? "#00e5a0" : "var(--text-muted)",
        }}>
          {c.volOiRatio.toFixed(2)}x
        </span>
      </td>
      <td style={{ padding: "9px 10px", fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
        {ivPct}%
      </td>
      {/* Greeks — only shown when Polygon data is available */}
      <td style={{ padding: "9px 10px", fontFamily: "JetBrains Mono,monospace", fontSize: 10 }}>
        {c.delta != null ? (
          <span style={{ color: c.delta > 0 ? "#00e5a0" : "#ff3b3b" }}>{c.delta.toFixed(2)}</span>
        ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
      </td>
      <td style={{ padding: "9px 10px", fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)" }}>
        {c.theta != null ? (
          <span style={{ color: "#ff8c42" }}>{c.theta.toFixed(3)}</span>
        ) : <span>—</span>}
      </td>
    </tr>
  );
}

export default function OptionsPage() {
  const [ticker, setTicker] = useState("SPY");
  const [input, setInput] = useState("SPY");
  const [data, setData] = useState<OptionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"all" | "calls" | "puts" | "unusual">("unusual");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  const fetchOptions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/options?ticker=${ticker}`);
      const d = await res.json();
      setData(d);
    } catch {}
    setLoading(false);
  }, [ticker]);

  useEffect(() => { fetchOptions(); }, [fetchOptions]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setTicker(input.toUpperCase().trim());
  };

  const allContracts = data ? [...data.calls, ...data.puts].sort((a, b) => b.premium - a.premium) : [];
  const displayed = tab === "calls" ? data?.calls ?? []
    : tab === "puts" ? data?.puts ?? []
    : tab === "unusual" ? allContracts.filter(c => c.unusual)
    : allContracts;

  const pcRatio = data?.putCallRatio ?? 1;
  const sentiment = pcRatio < 0.7 ? { label: "BULLISH", color: "#00e5a0" }
    : pcRatio > 1.3 ? { label: "BEARISH", color: "#ff3b3b" }
    : { label: "NEUTRAL", color: "#94a3b8" };

  const quote = data?.quote;
  const pos = (quote?.changePct ?? 0) >= 0;

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1300, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="gradient-text font-bold" style={{ fontSize: 22, marginBottom: 3 }}>Options Flow</h1>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
            Unusual options activity · Put/Call ratio · Institutional positioning
          </p>
          {data?.source === "estimated" && (
            <span style={{
              display: "inline-block", marginTop: 6,
              fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
              letterSpacing: "0.1em", padding: "2px 8px", borderRadius: 3,
              background: "rgba(75,158,255,0.10)", color: "#4b9eff",
              border: "1px solid rgba(75,158,255,0.3)",
            }}>◈ LIVE PRICE · BLACK-SCHOLES ESTIMATED — real stock price, math-derived option values</span>
          )}
        </div>
        {/* Ticker search */}
        <form onSubmit={handleSearch} style={{ display: "flex", gap: 6 }}>
          <div style={{ position: "relative" }}>
            <Search size={12} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
            <input
              value={input}
              onChange={e => setInput(e.target.value.toUpperCase())}
              placeholder="Ticker…"
              style={{
                fontFamily: "JetBrains Mono,monospace", fontSize: 12, fontWeight: 700,
                background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4,
                color: "var(--text-primary)", padding: "7px 12px 7px 28px", width: 120,
                outline: "none",
              }}
            />
          </div>
          <button type="submit" style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
            background: "rgba(0,229,160,0.12)", border: "1px solid rgba(0,229,160,0.3)",
            borderRadius: 4, padding: "7px 14px", cursor: "pointer", color: "#00e5a0",
          }}>SCAN</button>
        </form>
      </div>

      {/* Quick ticker chips */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {DEFAULT_TICKERS.map(t => (
          <button key={t} onClick={() => { setTicker(t); setInput(t); }} style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
            padding: "3px 10px", borderRadius: 3, cursor: "pointer",
            background: ticker === t ? "rgba(0,229,160,0.12)" : "var(--bg-card)",
            border: `1px solid ${ticker === t ? "rgba(0,229,160,0.4)" : "var(--border)"}`,
            color: ticker === t ? "#00e5a0" : "var(--text-muted)",
          }}>{t}</button>
        ))}
      </div>

      {/* Stats row */}
      {data && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          {/* Price */}
          {quote && (
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "8px 14px" }}>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginBottom: 3, letterSpacing: "0.08em" }}>PRICE</p>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>${quote.price?.toFixed(2)}</p>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: pos ? "#00e5a0" : "#ff3b3b" }}>
                {pos ? "▲" : "▼"} {Math.abs(quote.changePct ?? 0).toFixed(2)}%
              </p>
            </div>
          )}
          {/* Put/Call ratio */}
          <div style={{ background: "var(--bg-card)", border: `1px solid ${sentiment.color}33`, borderRadius: 4, padding: "8px 14px", minWidth: 120 }}>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginBottom: 3, letterSpacing: "0.08em" }}>PUT/CALL RATIO</p>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 18, fontWeight: 700, color: sentiment.color }}>{pcRatio.toFixed(2)}</p>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: sentiment.color, fontWeight: 700 }}>{sentiment.label}</p>
          </div>
          {/* Call volume */}
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "8px 14px" }}>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginBottom: 3, letterSpacing: "0.08em" }}>CALL VOLUME</p>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 16, fontWeight: 700, color: "#00e5a0" }}>{fmtNum(data.totalCallVol)}</p>
          </div>
          {/* Put volume */}
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "8px 14px" }}>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginBottom: 3, letterSpacing: "0.08em" }}>PUT VOLUME</p>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 16, fontWeight: 700, color: "#ff3b3b" }}>{fmtNum(data.totalPutVol)}</p>
          </div>
          {/* Unusual count */}
          <div style={{ background: "var(--bg-card)", border: "1px solid rgba(245,166,35,0.3)", borderRadius: 4, padding: "8px 14px" }}>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginBottom: 3, letterSpacing: "0.08em" }}>⚡ UNUSUAL</p>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 16, fontWeight: 700, color: "#f5a623" }}>
              {allContracts.filter(c => c.unusual).length}
            </p>
          </div>
        </div>
      )}

      {/* Tab filter */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {([
          { key: "unusual", label: "⚡ Unusual Activity" },
          { key: "all", label: "All Flow" },
          { key: "calls", label: "Calls Only" },
          { key: "puts", label: "Puts Only" },
        ] as const).map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)} style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
            letterSpacing: "0.06em", padding: "5px 14px", borderRadius: 3, cursor: "pointer",
            background: tab === key ? "rgba(0,229,160,0.12)" : "var(--bg-card)",
            border: `1px solid ${tab === key ? "rgba(0,229,160,0.4)" : "var(--border)"}`,
            color: tab === key ? "#00e5a0" : "var(--text-muted)",
          }}>{label}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60, gap: 10 }}>
          <RefreshCw size={14} className="animate-spin" style={{ color: "#00e5a0" }} />
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 12, color: "var(--text-muted)" }}>Loading options chain…</span>
        </div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)", fontFamily: "JetBrains Mono,monospace", fontSize: 12 }}>
          No {tab === "unusual" ? "unusual options activity" : "contracts"} found for {ticker}.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["TYPE", "STRIKE", "EXPIRY", "PRICE", "PREMIUM", "VOLUME", "OPEN INT", "VOL/OI", "IV", "Δ DELTA", "Θ THETA"].map(h => (
                  <th key={h} style={{
                    fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
                    letterSpacing: "0.1em", color: "var(--text-muted)", textAlign: "left",
                    padding: "8px 10px", whiteSpace: "nowrap",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.slice(0, 100).map((c, i) => (
                <ContractRow key={i} c={c} onClick={() => setSelectedTicker(ticker)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginTop: 16 }}>
        Data: Yahoo Finance options chain · Vol/OI &gt; 0.5 flagged unusual · Not financial advice
      </p>

      {selectedTicker && <SymbolModal ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />}
    </div>
  );
}
