"use client";
import { useState, useEffect, useCallback } from "react";
import { Plus, RefreshCw, TrendingUp, TrendingDown, Star, Search, X, Grid, LayoutGrid } from "lucide-react";
import SymbolModal from "@/components/SymbolModal";

interface Quote { price: number; change: number; changePct: number }

const DEFAULT_TICKERS = ["NVDA", "AAPL", "TSLA", "MSFT", "AMZN", "META", "GOOGL", "BRK-B", "JPM", "PLTR"];

function TickerCard({ ticker, quote, onRemove, onOpen }: { ticker: string; quote?: Quote; onRemove: () => void; onOpen: () => void }) {
  const pos = (quote?.changePct ?? 0) >= 0;
  return (
    <div
      onClick={onOpen}
      style={{
        background: "var(--bg-card)", border: "1px solid var(--border)",
        borderRadius: 4, padding: "14px 16px", position: "relative",
        transition: "border-color 0.15s", cursor: "pointer",
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--green)")}
      onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--border)")}
    >
      <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{
        position: "absolute", top: 8, right: 8,
        background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 2,
        zIndex: 1,
      }}>
        <X size={12} />
      </button>

      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="mono font-bold" style={{ fontSize: 16, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>{ticker}</p>
          <a href={`https://finance.yahoo.com/quote/${ticker}`} target="_blank" rel="noopener noreferrer"
            className="mono text-xs hover:underline" style={{ color: "var(--text-muted)" }}>
            Yahoo Finance ↗
          </a>
        </div>
        {quote && (
          <div style={{ textAlign: "right" }}>
            <p className="num font-bold" style={{ fontSize: 20, color: "var(--text-primary)" }}>
              ${quote.price.toFixed(2)}
            </p>
          </div>
        )}
        {!quote && (
          <div style={{ textAlign: "right" }}>
            <p className="mono text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>
          </div>
        )}
      </div>

      {quote && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5" style={{
            background: pos ? "var(--green-dim)" : "var(--red-dim)",
            border: `1px solid ${pos ? "rgba(0,229,160,0.2)" : "rgba(255,59,59,0.2)"}`,
            borderRadius: 3, padding: "3px 8px",
          }}>
            {pos ? <TrendingUp size={11} style={{ color: "var(--green)" }} /> : <TrendingDown size={11} style={{ color: "var(--red)" }} />}
            <span className="num font-bold text-xs" style={{ color: pos ? "var(--green)" : "var(--red)" }}>
              {pos ? "+" : ""}{quote.changePct.toFixed(2)}%
            </span>
          </div>
          <span className="num text-xs" style={{ color: pos ? "var(--green)" : "var(--red)" }}>
            {pos ? "+" : ""}${Math.abs(quote.change).toFixed(2)}
          </span>
        </div>
      )}

      {/* Mini price bar */}
      {quote && (
        <div style={{ marginTop: 10, height: 2, background: "var(--border)", borderRadius: 2 }}>
          <div style={{
            height: "100%", borderRadius: 2,
            width: `${Math.min(50 + (quote.changePct / 5) * 50, 100)}%`,
            background: pos ? "var(--green)" : "var(--red)",
            transition: "width 0.4s ease",
          }} />
        </div>
      )}
    </div>
  );
}

function heatColor(pct: number): string {
  const clamped = Math.max(-5, Math.min(5, pct));
  if (clamped >= 0) {
    const intensity = clamped / 5;
    return `rgba(0,${Math.round(180 + intensity * 75)},${Math.round(110 + intensity * 50)},${0.15 + intensity * 0.5})`;
  } else {
    const intensity = Math.abs(clamped) / 5;
    return `rgba(${Math.round(180 + intensity * 75)},${Math.round(30 + intensity * 10)},${Math.round(30 + intensity * 10)},${0.15 + intensity * 0.5})`;
  }
}

function HeatmapCell({ ticker, quote, onOpen }: { ticker: string; quote?: Quote; onOpen: () => void }) {
  const pct = quote?.changePct ?? 0;
  const pos = pct >= 0;
  const bg = quote ? heatColor(pct) : "rgba(255,255,255,0.03)";
  const border = quote
    ? pos ? `1px solid rgba(0,229,160,${Math.min(0.1 + Math.abs(pct) / 10, 0.5)})` : `1px solid rgba(255,59,59,${Math.min(0.1 + Math.abs(pct) / 10, 0.5)})`
    : "1px solid var(--border)";
  return (
    <div onClick={onOpen} style={{
      background: bg, border, borderRadius: 4, padding: "14px 10px",
      cursor: "pointer", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", minHeight: 80,
      transition: "all 0.2s",
    }}
      onMouseEnter={e => ((e.currentTarget as HTMLElement).style.opacity = "0.85")}
      onMouseLeave={e => ((e.currentTarget as HTMLElement).style.opacity = "1")}
    >
      <span style={{ fontFamily: "JetBrains Mono,monospace", fontWeight: 700, fontSize: 13, color: "var(--text-primary)", marginBottom: 4 }}>{ticker}</span>
      {quote ? (
        <>
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontWeight: 700, fontSize: 15, color: pos ? "var(--green)" : "var(--red)" }}>
            {pos ? "+" : ""}{pct.toFixed(2)}%
          </span>
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
            ${quote.price.toFixed(2)}
          </span>
        </>
      ) : (
        <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)" }}>—</span>
      )}
    </div>
  );
}

export default function WatchlistPage() {
  const [tickers, setTickers] = useState<string[]>(DEFAULT_TICKERS);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [gainers, setGainers] = useState<string[]>([]);
  const [losers, setLosers] = useState<string[]>([]);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"cards" | "heatmap">("cards");

  // Load watchlist from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ww-watchlist");
      if (saved) setTickers(JSON.parse(saved));
    } catch {}
  }, []);

  // Save to localStorage whenever tickers change
  useEffect(() => {
    try { localStorage.setItem("ww-watchlist", JSON.stringify(tickers)); } catch {}
  }, [tickers]);

  const fetchQuotes = useCallback(async () => {
    if (!tickers.length) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/stocks?tickers=${tickers.join(",")}`);
      const d = await r.json();
      const q = d.quotes ?? {};
      setQuotes(q);
      setLastUpdate(new Date());
      const sorted = Object.entries(q).sort((a, b) => (b[1] as Quote).changePct - (a[1] as Quote).changePct);
      setGainers(sorted.slice(0, 3).map(([t]) => t));
      setLosers(sorted.slice(-3).reverse().map(([t]) => t));
    } finally {
      setLoading(false);
    }
  }, [tickers]);

  useEffect(() => {
    fetchQuotes();
    const iv = setInterval(fetchQuotes, 1000);
    return () => clearInterval(iv);
  }, [fetchQuotes]);

  function addTicker() {
    const t = input.trim().toUpperCase();
    if (!t || tickers.includes(t)) return;
    setTickers(prev => [...prev, t]);
    setInput("");
  }
  function removeTicker(t: string) { setTickers(prev => prev.filter(x => x !== t)); }

  const totalChange = Object.values(quotes).reduce((s, q) => s + q.changePct, 0);
  const avgChange = Object.values(quotes).length ? totalChange / Object.values(quotes).length : 0;
  const upCount   = Object.values(quotes).filter(q => q.changePct >= 0).length;
  const downCount = Object.values(quotes).filter(q => q.changePct < 0).length;

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="gradient-text font-bold mb-0.5" style={{ fontSize: 22 }}>Watchlist</h1>
          <p className="mono text-xs" style={{ color: "var(--text-muted)" }}>
            Track any stock · Live prices from Yahoo Finance · 1s refresh
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div style={{ display: "flex", gap: 4 }}>
            {[
              { mode: "cards" as const, label: "Cards", icon: LayoutGrid },
              { mode: "heatmap" as const, label: "Heatmap", icon: Grid },
            ].map(({ mode, label, icon: Icon }) => (
              <button key={mode} onClick={() => setViewMode(mode)} style={{
                fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
                padding: "4px 10px", borderRadius: 3, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 5,
                background: viewMode === mode ? "rgba(0,229,160,0.12)" : "var(--bg-card)",
                border: `1px solid ${viewMode === mode ? "rgba(0,229,160,0.3)" : "var(--border)"}`,
                color: viewMode === mode ? "var(--green)" : "var(--text-muted)",
              }}>
                <Icon size={11} />{label}
              </button>
            ))}
          </div>
          <div className={`flex items-center gap-1.5 mono text-xs`} style={{ color: "var(--text-muted)" }}>
            <RefreshCw size={10} className={loading ? "animate-spin" : ""} style={{ color: "var(--green)" }} />
            {lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : "Loading…"}
          </div>
        </div>
      </div>

      {/* Market summary bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
        {[
          { label: "TRACKED", value: tickers.length.toString(), sub: "symbols", color: "var(--blue)" },
          { label: "AVG CHANGE", value: `${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(2)}%`, sub: "today", color: avgChange >= 0 ? "var(--green)" : "var(--red)" },
          { label: "GAINERS", value: upCount.toString(), sub: `of ${Object.values(quotes).length}`, color: "var(--green)" },
          { label: "LOSERS",  value: downCount.toString(), sub: `of ${Object.values(quotes).length}`, color: "var(--red)" },
        ].map(m => (
          <div key={m.label} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "10px 14px" }}>
            <p className="stat-label">{m.label}</p>
            <p className="num font-bold" style={{ fontSize: 20, color: m.color }}>{m.value}</p>
            <p className="mono text-xs" style={{ color: "var(--text-muted)" }}>{m.sub}</p>
          </div>
        ))}
      </div>

      {/* Add ticker */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4 }}>
          <Search size={13} style={{ color: "var(--text-muted)" }} />
          <input
            value={input}
            onChange={e => setInput(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && addTicker()}
            placeholder="Add ticker… (e.g. NVDA, BTC-USD)"
            className="mono bg-transparent outline-none flex-1 text-sm"
            style={{ color: "var(--text-primary)" }}
          />
        </div>
        <button onClick={addTicker} className="flex items-center gap-2 mono font-bold text-xs px-4" style={{
          background: "rgba(0,229,160,0.12)", border: "1px solid rgba(0,229,160,0.3)",
          borderRadius: 4, color: "var(--green)", cursor: "pointer",
        }}>
          <Plus size={13} /> ADD
        </button>
      </div>

      {/* Ticker grid — cards or heatmap */}
      {viewMode === "heatmap" ? (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 6 }}>
            {tickers.map(t => (
              <HeatmapCell key={t} ticker={t} quote={quotes[t]} onOpen={() => setSelectedTicker(t)} />
            ))}
            {tickers.length === 0 && (
              <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 60 }}>
                <Star size={28} style={{ color: "var(--text-muted)", margin: "0 auto 10px" }} />
                <p className="mono text-sm" style={{ color: "var(--text-muted)" }}>No tickers yet. Add one above.</p>
              </div>
            )}
          </div>
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 16, justifyContent: "center" }}>
            {[
              { label: "> +3%", color: "rgba(0,229,160,0.6)" },
              { label: "+1–3%", color: "rgba(0,200,140,0.35)" },
              { label: "0%", color: "rgba(255,255,255,0.08)" },
              { label: "-1–3%", color: "rgba(220,50,50,0.35)" },
              { label: "< -3%", color: "rgba(255,59,59,0.6)" },
            ].map(({ label, color }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 12, height: 12, borderRadius: 2, background: color }} />
                <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)" }}>{label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
          {tickers.map(t => (
            <TickerCard key={t} ticker={t} quote={quotes[t]} onRemove={() => removeTicker(t)} onOpen={() => setSelectedTicker(t)} />
          ))}
          {tickers.length === 0 && (
            <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 60 }}>
              <Star size={28} style={{ color: "var(--text-muted)", margin: "0 auto 10px" }} />
              <p className="mono text-sm" style={{ color: "var(--text-muted)" }}>No tickers yet. Add one above.</p>
            </div>
          )}
        </div>
      )}

      {/* Top movers */}
      {(gainers.length > 0 || losers.length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
          {[
            { label: "TOP GAINERS", items: gainers, color: "var(--green)" },
            { label: "TOP LOSERS",  items: losers,  color: "var(--red)" },
          ].map(({ label, items, color }) => (
            <div key={label} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
              <div className="bb-header" style={{ color }}>{label}</div>
              <div style={{ padding: "8px 0" }}>
                {items.map(t => {
                  const q = quotes[t];
                  if (!q) return null;
                  return (
                    <div key={t} className="flex items-center justify-between" style={{ padding: "6px 14px", borderBottom: "1px solid var(--border)" }}>
                      <span className="mono font-bold text-sm" style={{ color: "var(--text-primary)" }}>{t}</span>
                      <span className="num font-bold text-sm" style={{ color }}>
                        {q.changePct >= 0 ? "+" : ""}{q.changePct.toFixed(2)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="mono text-xs mt-4" style={{ color: "var(--text-muted)", textAlign: "center" }}>
        Data: Yahoo Finance · Watchlist saved locally · Not financial advice
      </p>

      {selectedTicker && (
        <SymbolModal ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />
      )}
    </div>
  );
}
