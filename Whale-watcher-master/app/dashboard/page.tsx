"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { TrendingUp, TrendingDown, Activity, Users, Wallet, DollarSign, RefreshCw, Zap } from "lucide-react";
import { CONGRESS_FALLBACK, INVESTORS, WHALE_WALLETS, amountMidpoint, partyColor } from "@/lib/data";
import { format, parseISO, formatDistanceToNow } from "date-fns";
import SymbolModal from "@/components/SymbolModal";

interface Trade {
  id: string; representative: string; party: string; ticker: string;
  assetName: string; type: string; amount: string; transactionDate: string;
  disclosureDate: string; sector?: string; excessReturn?: number | null;
}
interface Index {
  ticker: string; label: string; type: string;
  price?: number; change?: number; changePct?: number;
}

function fmt(n: number, isCrypto = false) {
  if (isCrypto && n > 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n > 100) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

// ── Market Indices Bar ──────────────────────────────────────────────────────
function IndexTicker({ idx, onClick }: { idx: Index; onClick: () => void }) {
  const pos = (idx.changePct ?? 0) >= 0;
  const color = idx.type === "fear"
    ? (idx.price ?? 0) > 30 ? "var(--red)" : "var(--green)"
    : pos ? "var(--green)" : "var(--red)";

  return (
    <button onClick={onClick} style={{
      display: "flex", flexDirection: "column", alignItems: "flex-start",
      padding: "6px 14px", borderRight: "1px solid var(--border)",
      background: "none", border: "none", borderRight: "1px solid var(--border)",
      cursor: "pointer", minWidth: 110,
    }}
      onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
      onMouseLeave={e => (e.currentTarget.style.background = "none")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
        <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-muted)" }}>{idx.label}</span>
        {idx.type === "fear" && <span style={{ fontSize: 8, color: "var(--text-muted)" }}>FEAR</span>}
      </div>
      {idx.price != null ? (
        <>
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
            {fmt(idx.price, idx.type === "crypto")}
          </span>
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 600, color }}>
            {pos ? "▲" : "▼"} {Math.abs(idx.changePct ?? 0).toFixed(2)}%
          </span>
        </>
      ) : (
        <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>—</span>
      )}
    </button>
  );
}

// ── Hot Stocks cluster signal ───────────────────────────────────────────────
function HotStockRow({ ticker, buys, sells, total, onClick }: {
  ticker: string; buys: number; sells: number; total: number; onClick: () => void;
}) {
  const buyPct = total ? (buys / total) * 100 : 0;
  const isBullish = buys >= sells;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 14px", borderBottom: "1px solid var(--border)" }}>
      <button onClick={onClick} style={{
        fontFamily: "JetBrains Mono,monospace", fontWeight: 700, fontSize: 13,
        color: "var(--green)", background: "none", border: "none", cursor: "pointer",
        padding: 0, minWidth: 52, textAlign: "left",
      }}>{ticker}</button>
      <div style={{ flex: 1, height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${buyPct}%`, height: "100%", background: "var(--green)", borderRadius: 2 }} />
      </div>
      <div style={{ display: "flex", gap: 8, fontFamily: "JetBrains Mono,monospace", fontSize: 10 }}>
        <span style={{ color: "var(--green)" }}>{buys}B</span>
        <span style={{ color: "var(--red)" }}>{sells}S</span>
        <span style={{ color: isBullish ? "var(--green)" : "var(--red)", fontWeight: 700 }}>
          {isBullish ? "▲" : "▼"} SIGNAL
        </span>
      </div>
    </div>
  );
}

// ── Trade row ───────────────────────────────────────────────────────────────
function TradeRow({ trade, onMemberClick, onTickerClick }: {
  trade: Trade; onMemberClick: (m: string) => void; onTickerClick: (t: string) => void;
}) {
  const isBuy = trade.type === "purchase";
  const pc = partyColor(trade.party as any);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{
        fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
        width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: 4, background: pc + "22", color: pc, flexShrink: 0,
      }}>{trade.party}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <button onClick={() => onMemberClick(trade.representative)} style={{
          fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: "var(--text-primary)",
          background: "none", border: "none", cursor: "pointer", padding: 0,
          textAlign: "left", display: "block", width: "100%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "var(--green)")}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "var(--text-primary)")}
        >{trade.representative}</button>
        {trade.ticker && trade.ticker !== "--" ? (
          <button onClick={() => onTickerClick(trade.ticker)} style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)",
            background: "none", border: "none", cursor: "pointer", padding: 0,
          }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "var(--green)")}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "var(--text-muted)")}
          >{trade.ticker}</button>
        ) : (
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)" }}>{trade.assetName?.slice(0, 22)}</span>
        )}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <span style={{
          fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
          padding: "2px 6px", borderRadius: 3,
          background: isBuy ? "rgba(0,229,160,0.12)" : "rgba(255,59,59,0.12)",
          color: isBuy ? "var(--green)" : "var(--red)",
          border: `1px solid ${isBuy ? "rgba(0,229,160,0.25)" : "rgba(255,59,59,0.25)"}`,
        }}>{isBuy ? "BUY" : "SELL"}</span>
        {trade.excessReturn != null && (
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, marginTop: 2, color: trade.excessReturn >= 0 ? "var(--green)" : "var(--red)" }}>
            {trade.excessReturn >= 0 ? "+" : ""}{trade.excessReturn.toFixed(1)}% vs SPY
          </p>
        )}
      </div>
    </div>
  );
}

// ── Fear & Greed widget ─────────────────────────────────────────────────────
interface FearGreedData { score: number; rating: string; prev_week: number; }

function FearGreedWidget({ data }: { data: FearGreedData | null }) {
  if (!data) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", minHeight: 120 }}>
        <RefreshCw size={13} className="animate-spin" style={{ color: "var(--green)" }} />
      </div>
    );
  }

  const { score, rating, prev_week } = data;
  const scoreColor =
    score <= 25 ? "#ff3b3b" :
    score <= 45 ? "#f5a623" :
    score <= 55 ? "#94a3b8" :
    "#00e5a0";
  const diff = score - prev_week;
  const arrow = diff >= 0 ? "↑" : "↓";
  const arrowColor = diff >= 0 ? "var(--green)" : "var(--red)";

  return (
    <div style={{ padding: "10px 14px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 36, fontWeight: 700, color: scoreColor, lineHeight: 1 }}>
          {score}
        </span>
        <div>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700, color: scoreColor, textTransform: "uppercase" }}>{rating}</p>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
            <span style={{ color: arrowColor }}>{arrow} {Math.abs(diff)} pts</span>
            {" "}vs last week
          </p>
        </div>
      </div>
      {/* Thermometer bar */}
      <div style={{ position: "relative", height: 6, borderRadius: 3, background: "linear-gradient(to right, #ff3b3b, #f5a623, #94a3b8, #00e5a0)", marginBottom: 6 }}>
        <div style={{
          position: "absolute", top: "50%", transform: "translate(-50%, -50%)",
          left: `${score}%`,
          width: 10, height: 10, borderRadius: "50%",
          background: scoreColor, border: "2px solid var(--bg-card)",
          boxShadow: `0 0 6px ${scoreColor}`,
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "#ff3b3b" }}>FEAR</span>
        <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "#94a3b8" }}>NEUTRAL</span>
        <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "#00e5a0" }}>GREED</span>
      </div>
    </div>
  );
}

// ── WSB Trending widget ─────────────────────────────────────────────────────
interface WsbData { tickers: string[]; topPosts: Array<{ title: string; score: number; url: string }>; }

function WsbWidget({ data, onTickerClick }: { data: WsbData | null; onTickerClick: (t: string) => void }) {
  if (!data) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", minHeight: 120 }}>
        <RefreshCw size={13} className="animate-spin" style={{ color: "var(--green)" }} />
      </div>
    );
  }

  const topPost = data.topPosts[0];

  return (
    <div style={{ padding: "10px 14px 12px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {data.tickers.slice(0, 8).map((ticker, i) => (
          <button
            key={ticker}
            onClick={() => onTickerClick(ticker)}
            style={{
              fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
              padding: "3px 8px", borderRadius: 3,
              background: i < 3 ? "rgba(0,229,160,0.08)" : "rgba(245,166,35,0.08)",
              border: `1px solid ${i < 3 ? "rgba(0,229,160,0.35)" : "rgba(245,166,35,0.35)"}`,
              color: i < 3 ? "var(--green)" : "var(--gold)",
              cursor: "pointer",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = i < 3 ? "rgba(0,229,160,0.18)" : "rgba(245,166,35,0.18)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = i < 3 ? "rgba(0,229,160,0.08)" : "rgba(245,166,35,0.08)"; }}
          >
            {ticker}
          </button>
        ))}
      </div>
      {topPost && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: 4 }}>TOP POST</p>
          <a
            href={topPost.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-secondary)", textDecoration: "none", display: "block", lineHeight: 1.4 }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--green)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
          >
            {topPost.title.length > 80 ? topPost.title.slice(0, 80) + "…" : topPost.title}
          </a>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginTop: 3 }}>
            ▲ {topPost.score.toLocaleString()} upvotes
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [trades, setTrades]             = useState<Trade[]>(CONGRESS_FALLBACK.slice(0, 12) as Trade[]);
  const [allTrades, setAllTrades]       = useState<Trade[]>(CONGRESS_FALLBACK as Trade[]);
  const [source, setSource]             = useState<"live" | "fallback">("fallback");
  const [indices, setIndices]           = useState<Index[]>([]);
  const [indicesLoading, setIndLoading] = useState(true);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate]     = useState<Date | null>(null);
  const [fearGreed, setFearGreed]       = useState<FearGreedData | null>(null);
  const [wsbData, setWsbData]           = useState<WsbData | null>(null);

  // Fetch congress trades
  const fetchTrades = useCallback(() => {
    fetch("/api/congress")
      .then(r => r.json())
      .then(d => {
        setTrades(d.trades.slice(0, 12));
        setAllTrades(d.trades);
        setSource(d.source);
        setLastUpdate(new Date());
      })
      .catch(() => {});
  }, []);

  // Fetch market indices
  const fetchIndices = useCallback(() => {
    fetch("/api/indices")
      .then(r => r.json())
      .then(d => { setIndices(d.indices ?? []); setIndLoading(false); })
      .catch(() => setIndLoading(false));
  }, []);

  // Fetch Fear & Greed
  const fetchFearGreed = useCallback(() => {
    fetch("/api/fear-greed")
      .then(r => r.json())
      .then(d => setFearGreed(d))
      .catch(() => {});
  }, []);

  // Fetch WSB trending
  const fetchWsb = useCallback(() => {
    fetch("/api/wsb")
      .then(r => r.json())
      .then(d => setWsbData(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchTrades();
    fetchIndices();
    fetchFearGreed();
    fetchWsb();
    const iv1 = setInterval(fetchTrades, 30000);
    const iv2 = setInterval(fetchIndices, 1000);
    const iv3 = setInterval(fetchFearGreed, 60000);
    const iv4 = setInterval(fetchWsb, 60000);
    return () => { clearInterval(iv1); clearInterval(iv2); clearInterval(iv3); clearInterval(iv4); };
  }, [fetchTrades, fetchIndices, fetchFearGreed, fetchWsb]);

  // Hot stocks: top tickers traded by most Congress members
  const hotStocks = useMemo(() => {
    const map: Record<string, { buys: number; sells: number }> = {};
    allTrades.forEach(t => {
      if (!t.ticker || t.ticker === "--") return;
      if (!map[t.ticker]) map[t.ticker] = { buys: 0, sells: 0 };
      if (t.type === "purchase") map[t.ticker].buys++;
      else map[t.ticker].sells++;
    });
    return Object.entries(map)
      .map(([ticker, { buys, sells }]) => ({ ticker, buys, sells, total: buys + sells }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  }, [allTrades]);

  // Congress sentiment
  const buyCount  = trades.filter(t => t.type === "purchase").length;
  const sellCount = trades.length - buyCount;
  const sentiment = buyCount > sellCount ? "Bullish" : "Bearish";

  // Top sectors from live data
  const topSectors = useMemo(() => {
    const acc: Record<string, number> = {};
    allTrades.forEach(t => { if (t.sector) acc[t.sector] = (acc[t.sector] ?? 0) + 1; });
    return Object.entries(acc).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [allTrades]);

  const spy  = indices.find(i => i.ticker === "SPY");
  const vix  = indices.find(i => i.ticker === "VIX");
  const marketUp = (spy?.changePct ?? 0) >= 0;

  // lazy import modal for congress member
  const [CongressModal, setCongressModal] = useState<any>(null);
  useEffect(() => {
    import("@/components/CongressMemberModal").then(m => setCongressModal(() => m.default));
  }, []);

  return (
    <div style={{ padding: "0 0 32px", maxWidth: 1300, margin: "0 auto" }}>

      {/* ── Live Market Indices Bar ──────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "stretch", borderBottom: "1px solid var(--border)",
        background: "var(--bg-secondary)", overflowX: "auto",
      }}>
        {indicesLoading ? (
          <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
            <RefreshCw size={11} className="animate-spin" style={{ color: "var(--green)" }} />
            <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10 }}>Loading markets…</span>
          </div>
        ) : indices.map(idx => (
          <IndexTicker key={idx.ticker} idx={idx}
            onClick={() => { if (idx.type !== "fear") setSelectedTicker(idx.ticker); }} />
        ))}
        <div style={{ flex: 1 }} />
        {lastUpdate && (
          <div style={{ padding: "6px 14px", display: "flex", alignItems: "center", gap: 5 }}>
            <Activity size={9} style={{ color: "var(--green)" }} />
            <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)" }}>
              {lastUpdate.toLocaleTimeString()} · 1s
            </span>
          </div>
        )}
      </div>

      <div style={{ padding: "20px 24px 0" }}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
          <div>
            <h1 className="gradient-text font-bold" style={{ fontSize: 22, marginBottom: 3 }}>Smart Money Dashboard</h1>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
              Congress · Wall St · Crypto · 1s live refresh
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {vix && (
              <div style={{
                fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontWeight: 700, padding: "4px 10px",
                background: (vix.price ?? 0) > 30 ? "rgba(255,59,59,0.12)" : (vix.price ?? 0) > 20 ? "rgba(245,166,35,0.12)" : "rgba(0,229,160,0.12)",
                border: `1px solid ${(vix.price ?? 0) > 30 ? "rgba(255,59,59,0.3)" : (vix.price ?? 0) > 20 ? "rgba(245,166,35,0.3)" : "rgba(0,229,160,0.3)"}`,
                color: (vix.price ?? 0) > 30 ? "var(--red)" : (vix.price ?? 0) > 20 ? "var(--gold)" : "var(--green)",
                borderRadius: 4,
              }}>
                VIX {vix.price?.toFixed(1)} · {(vix.price ?? 0) > 30 ? "HIGH FEAR" : (vix.price ?? 0) > 20 ? "CAUTION" : "LOW FEAR"}
              </div>
            )}
            <div style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "4px 10px", borderRadius: 4,
              background: source === "live" ? "rgba(0,229,160,0.1)" : "rgba(245,166,35,0.1)",
              border: `1px solid ${source === "live" ? "rgba(0,229,160,0.25)" : "rgba(245,166,35,0.25)"}`,
            }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: source === "live" ? "var(--green)" : "var(--gold)", animation: source === "live" ? "pulse 2s infinite" : "none" }} />
              <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700, color: source === "live" ? "var(--green)" : "var(--gold)" }}>
                {source === "live" ? "LIVE DATA" : "CACHED"}
              </span>
            </div>
          </div>
        </div>

        {/* ── Stats row ──────────────────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
          {[
            { label: "CONGRESS SENTIMENT", value: sentiment, sub: `${buyCount} buys · ${sellCount} sells (recent)`, color: buyCount >= sellCount ? "var(--green)" : "var(--red)", icon: buyCount >= sellCount ? TrendingUp : TrendingDown },
            { label: "AUM TRACKED", value: "$336B+", sub: "SEC 13F + ARK daily", color: "var(--blue)", icon: DollarSign },
            { label: "MARKET", value: marketUp ? "RISK-ON" : "RISK-OFF", sub: `SPY ${(spy?.changePct ?? 0) >= 0 ? "+" : ""}${(spy?.changePct ?? 0).toFixed(2)}% today`, color: marketUp ? "var(--green)" : "var(--red)", icon: Activity },
            { label: "WHALE WALLETS", value: String(WHALE_WALLETS.length), sub: "BTC + ETH on-chain", color: "var(--gold)", icon: Wallet },
          ].map(({ label, value, sub, color, icon: Icon }) => (
            <div key={label} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <Icon size={11} style={{ color }} />
                <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-muted)", textTransform: "uppercase" }}>{label}</span>
              </div>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 20, fontWeight: 700, color, marginBottom: 2 }}>{value}</p>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)" }}>{sub}</p>
            </div>
          ))}
        </div>

        {/* ── Main 3-column grid ─────────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px 240px", gap: 14 }}>

          {/* ── Recent Congress Trades ─────────────────────────────────── */}
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
            <div className="bb-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>Recent Congress Trades</span>
              <a href="/congress" style={{ color: "var(--green)", fontSize: 9, textDecoration: "none", fontWeight: 700 }}>VIEW ALL →</a>
            </div>
            <div style={{ padding: "4px 14px 8px" }}>
              {trades.length === 0 ? (
                <div style={{ padding: "24px 0", textAlign: "center", color: "var(--text-muted)", fontFamily: "JetBrains Mono,monospace", fontSize: 11 }}>
                  <RefreshCw size={14} className="animate-spin" style={{ color: "var(--green)", margin: "0 auto 8px" }} />
                  Loading…
                </div>
              ) : trades.map(t => (
                <TradeRow key={t.id} trade={t}
                  onMemberClick={setSelectedMember}
                  onTickerClick={setSelectedTicker}
                />
              ))}
            </div>
          </div>

          {/* ── Center column ───────────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Hot Stocks cluster signal */}
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
              <div className="bb-header" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Zap size={9} style={{ color: "var(--gold)" }} />
                <span style={{ color: "var(--gold)" }}>CLUSTER SIGNAL</span>
              </div>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", padding: "6px 14px 4px" }}>
                Stocks traded by most Congress members
              </p>
              {hotStocks.map(h => (
                <HotStockRow key={h.ticker} {...h} onClick={() => setSelectedTicker(h.ticker)} />
              ))}
              <div style={{ padding: "6px 14px", borderTop: "1px solid var(--border)" }}>
                <a href="/congress" style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--green)", textDecoration: "none" }}>
                  Full Congress data →
                </a>
              </div>
            </div>

            {/* Top Sectors */}
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
              <div className="bb-header">Top Sectors</div>
              <div style={{ padding: "8px 14px" }}>
                {topSectors.map(([sector, count], i) => (
                  <div key={sector} style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-secondary)" }}>{sector}</span>
                      <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)" }}>{count}</span>
                    </div>
                    <div style={{ height: 3, background: "var(--border)", borderRadius: 2 }}>
                      <div style={{
                        width: `${(count / (topSectors[0]?.[1] ?? 1)) * 100}%`,
                        height: "100%", borderRadius: 2,
                        background: ["var(--green)", "var(--blue)", "var(--gold)", "#a855f7", "#ec4899"][i] ?? "var(--green)",
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Right column — Investors ────────────────────────────────── */}
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
            <div className="bb-header">Famous Investors</div>
            <div>
              {INVESTORS.map(inv => (
                <a key={inv.id} href="/investors" style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                  borderBottom: "1px solid var(--border)", textDecoration: "none",
                  transition: "background 0.1s",
                }}
                  onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)")}
                  onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = "none")}
                >
                  <span style={{ fontSize: 18 }}>{inv.avatar}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{inv.name}</p>
                    <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)" }}>{inv.fund}</p>
                  </div>
                  <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontWeight: 700, color: "var(--green)", flexShrink: 0 }}>{inv.aum}</span>
                </a>
              ))}
              <div style={{ padding: "8px 14px" }}>
                <a href="/investors" style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--green)", textDecoration: "none" }}>
                  See full holdings & charts →
                </a>
              </div>
            </div>
          </div>
          {/* ── Fear & Greed + WSB row ─────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>

          {/* Fear & Greed */}
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
            <div className="bb-header" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Activity size={9} style={{ color: fearGreed ? (fearGreed.score <= 45 ? "#ff3b3b" : fearGreed.score <= 55 ? "#94a3b8" : "#00e5a0") : "var(--text-muted)" }} />
              <span>FEAR &amp; GREED INDEX</span>
              <span style={{ marginLeft: "auto", fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "var(--text-muted)", letterSpacing: "0.1em" }}>CNN · 5 MIN CACHE</span>
            </div>
            <FearGreedWidget data={fearGreed} />
          </div>

          {/* WSB Trending */}
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
            <div className="bb-header" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <TrendingUp size={9} style={{ color: "var(--gold)" }} />
              <span style={{ color: "var(--gold)" }}>WSB TRENDING</span>
              <span style={{ marginLeft: "auto", fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "var(--text-muted)", letterSpacing: "0.1em" }}>r/wallstreetbets · 1 MIN</span>
            </div>
            <WsbWidget data={wsbData} onTickerClick={setSelectedTicker} />
          </div>

        </div>

      </div>
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {selectedTicker && (
        <SymbolModal ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />
      )}
      {selectedMember && CongressModal && (
        <CongressModal
          member={selectedMember}
          trades={allTrades.filter(t => t.representative === selectedMember)}
          partyColor={partyColor}
          amountMidpoint={amountMidpoint}
          onClose={() => setSelectedMember(null)}
        />
      )}
    </div>
  );
}
