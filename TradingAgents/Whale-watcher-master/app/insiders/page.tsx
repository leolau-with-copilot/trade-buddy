"use client";
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, TrendingUp, TrendingDown, Building } from "lucide-react";
import SymbolModal from "@/components/SymbolModal";

interface InsiderTrade {
  filingDate: string;
  tradeDate: string;
  ticker: string;
  company: string;
  insiderName: string;
  title: string;
  tradeType: string;
  price: number;
  qty: number;
  owned: number;
  value: number;
}

function fmtVal(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

export default function InsidersPage() {
  const [tab, setTab] = useState<"buys" | "sells">("buys");
  const [trades, setTrades] = useState<InsiderTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch(`/api/insiders?type=${tab}`);
      const data = await res.json();
      setTrades(data.trades ?? []);
      setLastUpdate(new Date());
    } catch {}
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    setLoading(true);
    fetchTrades();
  }, [fetchTrades]);

  const isBuy = tab === "buys";
  const accentColor = isBuy ? "#00e5a0" : "#ff3b3b";

  // Summary stats
  const totalValue = trades.reduce((s, t) => s + t.value, 0);
  const uniqueTickers = new Set(trades.map(t => t.ticker)).size;
  const topTicker = trades.reduce<Record<string, number>>((acc, t) => {
    acc[t.ticker] = (acc[t.ticker] ?? 0) + t.value;
    return acc;
  }, {});
  const topTickerEntry = Object.entries(topTicker).sort((a, b) => b[1] - a[1])[0];

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="gradient-text font-bold" style={{ fontSize: 22, marginBottom: 3 }}>Corporate Insider Trades</h1>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
            SEC Form 4 · CEO · CFO · Directors · Officers · Last 7 days
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {lastUpdate && (
            <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)" }}>
              {lastUpdate.toLocaleTimeString()}
            </span>
          )}
          <button onClick={fetchTrades} style={{
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4,
            padding: "6px 10px", cursor: "pointer", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4,
          }}>
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          { label: "TOTAL VALUE", value: fmtVal(totalValue) },
          { label: "UNIQUE TICKERS", value: uniqueTickers.toString() },
          { label: "TOP TICKER", value: topTickerEntry ? `${topTickerEntry[0]} (${fmtVal(topTickerEntry[1])})` : "—" },
          { label: "TRADES", value: trades.length.toString() },
        ].map(s => (
          <div key={s.label} style={{
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4,
            padding: "8px 14px",
          }}>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginBottom: 3, letterSpacing: "0.08em" }}>{s.label}</p>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 14, fontWeight: 700, color: accentColor }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Tab toggle */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {(["buys", "sells"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
            letterSpacing: "0.08em", textTransform: "uppercase",
            padding: "6px 18px", borderRadius: 4, cursor: "pointer",
            background: tab === t ? (t === "buys" ? "rgba(0,229,160,0.12)" : "rgba(255,59,59,0.12)") : "var(--bg-card)",
            border: `1px solid ${tab === t ? (t === "buys" ? "rgba(0,229,160,0.4)" : "rgba(255,59,59,0.4)") : "var(--border)"}`,
            color: tab === t ? (t === "buys" ? "#00e5a0" : "#ff3b3b") : "var(--text-muted)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            {t === "buys" ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
            {t === "buys" ? "Insider Buys" : "Insider Sells"}
          </button>
        ))}
      </div>

      {/* Info callout */}
      <div style={{
        background: `${accentColor}0a`, border: `1px solid ${accentColor}22`,
        borderRadius: 4, padding: "8px 14px", marginBottom: 16, fontSize: 11,
        color: "var(--text-muted)", lineHeight: 1.6,
      }}>
        {isBuy
          ? "Corporate insiders (CEOs, CFOs, Directors) buying their own stock is one of the strongest bullish signals — they have inside knowledge of company health."
          : "Insider sales can be routine (diversification, options exercise) but large unexpected sales warrant attention."}
      </div>

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60, gap: 10 }}>
          <RefreshCw size={14} className="animate-spin" style={{ color: "#00e5a0" }} />
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 12, color: "var(--text-muted)" }}>Loading SEC filings...</span>
        </div>
      ) : trades.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)", fontFamily: "JetBrains Mono,monospace", fontSize: 12 }}>
          No insider {tab} found in the last 7 days.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["FILED", "TICKER", "COMPANY", "INSIDER", "TITLE", "PRICE", "SHARES", "VALUE"].map(h => (
                  <th key={h} style={{
                    fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
                    letterSpacing: "0.1em", color: "var(--text-muted)", textAlign: "left",
                    padding: "8px 12px", whiteSpace: "nowrap",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={i} style={{
                  borderBottom: "1px solid var(--border)",
                  transition: "background 0.1s",
                }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                >
                  <td style={{ padding: "10px 12px", fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {t.filingDate.slice(0, 10)}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <button onClick={() => setSelectedTicker(t.ticker)} style={{
                      fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontWeight: 700,
                      color: accentColor, background: `${accentColor}12`,
                      border: `1px solid ${accentColor}33`, borderRadius: 3,
                      padding: "2px 8px", cursor: "pointer",
                    }}>{t.ticker}</button>
                  </td>
                  <td style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-primary)", maxWidth: 180 }}>
                    <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.company}
                    </span>
                  </td>
                  <td style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {t.insiderName}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <span style={{
                      fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
                      padding: "2px 6px", borderRadius: 3,
                      background: "rgba(255,255,255,0.05)", color: "var(--text-muted)",
                      border: "1px solid var(--border)", whiteSpace: "nowrap",
                    }}>
                      {t.title.slice(0, 20)}
                    </span>
                  </td>
                  <td style={{ padding: "10px 12px", fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    ${t.price.toFixed(2)}
                  </td>
                  <td style={{ padding: "10px 12px", fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {t.qty.toLocaleString()}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <span style={{
                      fontFamily: "JetBrains Mono,monospace", fontSize: 12, fontWeight: 700,
                      color: accentColor,
                    }}>
                      {fmtVal(t.value)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginTop: 16 }}>
        Data: OpenInsider · SEC Form 4 filings · Last 7 days · Not financial advice
      </p>

      {selectedTicker && <SymbolModal ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />}
    </div>
  );
}
