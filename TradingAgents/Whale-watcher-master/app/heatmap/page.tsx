"use client";
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Activity } from "lucide-react";
import SymbolModal from "@/components/SymbolModal";

interface Quote { price: number; change: number; changePct: number }

// ── Ticker groups ─────────────────────────────────────────────────────────
const GROUPS = [
  {
    label: "S&P 500 SECTORS",
    color: "#4b9eff",
    tickers: [
      { ticker: "XLK",  name: "Technology" },
      { ticker: "XLF",  name: "Financials" },
      { ticker: "XLV",  name: "Health Care" },
      { ticker: "XLY",  name: "Cons. Disc." },
      { ticker: "XLC",  name: "Comm. Svcs" },
      { ticker: "XLI",  name: "Industrials" },
      { ticker: "XLE",  name: "Energy" },
      { ticker: "XLP",  name: "Cons. Staples" },
      { ticker: "XLB",  name: "Materials" },
      { ticker: "XLRE", name: "Real Estate" },
      { ticker: "XLU",  name: "Utilities" },
      { ticker: "SPY",  name: "S&P 500" },
      { ticker: "QQQ",  name: "Nasdaq 100" },
      { ticker: "IWM",  name: "Russell 2000" },
      { ticker: "DIA",  name: "Dow Jones" },
    ],
  },
  {
    label: "MEGA CAPS",
    color: "#00e5a0",
    tickers: [
      { ticker: "NVDA", name: "NVIDIA" },
      { ticker: "AAPL", name: "Apple" },
      { ticker: "MSFT", name: "Microsoft" },
      { ticker: "AMZN", name: "Amazon" },
      { ticker: "GOOGL",name: "Alphabet" },
      { ticker: "META", name: "Meta" },
      { ticker: "TSLA", name: "Tesla" },
      { ticker: "BRK-B",name: "Berkshire" },
      { ticker: "JPM",  name: "JPMorgan" },
      { ticker: "V",    name: "Visa" },
      { ticker: "UNH",  name: "UnitedHealth" },
      { ticker: "AVGO", name: "Broadcom" },
      { ticker: "LLY",  name: "Eli Lilly" },
      { ticker: "XOM",  name: "ExxonMobil" },
      { ticker: "MA",   name: "Mastercard" },
      { ticker: "JNJ",  name: "Johnson & Johnson" },
      { ticker: "PG",   name: "Procter & Gamble" },
      { ticker: "HD",   name: "Home Depot" },
      { ticker: "COST", name: "Costco" },
      { ticker: "WMT",  name: "Walmart" },
      { ticker: "NFLX", name: "Netflix" },
      { ticker: "ORCL", name: "Oracle" },
      { ticker: "CRM",  name: "Salesforce" },
      { ticker: "AMD",  name: "AMD" },
      { ticker: "QCOM", name: "Qualcomm" },
      { ticker: "TXN",  name: "Texas Instruments" },
      { ticker: "INTU", name: "Intuit" },
      { ticker: "AMAT", name: "Appl. Materials" },
      { ticker: "MU",   name: "Micron" },
      { ticker: "PLTR", name: "Palantir" },
      { ticker: "BAC",  name: "Bank of America" },
      { ticker: "GS",   name: "Goldman Sachs" },
      { ticker: "ABBV", name: "AbbVie" },
      { ticker: "TMO",  name: "Thermo Fisher" },
      { ticker: "ACN",  name: "Accenture" },
    ],
  },
  {
    label: "CRYPTO",
    color: "#f5a623",
    tickers: [
      { ticker: "BTC-USD",  name: "Bitcoin" },
      { ticker: "ETH-USD",  name: "Ethereum" },
      { ticker: "SOL-USD",  name: "Solana" },
      { ticker: "BNB-USD",  name: "BNB" },
      { ticker: "XRP-USD",  name: "XRP" },
      { ticker: "DOGE-USD", name: "Dogecoin" },
      { ticker: "ADA-USD",  name: "Cardano" },
      { ticker: "AVAX-USD", name: "Avalanche" },
      { ticker: "SHIB-USD", name: "Shiba Inu" },
      { ticker: "LINK-USD", name: "Chainlink" },
      { ticker: "LTC-USD",  name: "Litecoin" },
      { ticker: "BCH-USD",  name: "Bitcoin Cash" },
      { ticker: "DOT-USD",  name: "Polkadot" },
      { ticker: "UNI-USD",  name: "Uniswap" },
      { ticker: "ATOM-USD", name: "Cosmos" },
      { ticker: "NEAR-USD", name: "NEAR" },
      { ticker: "MATIC-USD",name: "Polygon" },
      { ticker: "ICP-USD",  name: "Internet Computer" },
      { ticker: "FIL-USD",  name: "Filecoin" },
      { ticker: "ARB-USD",  name: "Arbitrum" },
      { ticker: "MSTR",     name: "MicroStrategy" },
      { ticker: "COIN",     name: "Coinbase" },
      { ticker: "HOOD",     name: "Robinhood" },
      { ticker: "MARA",     name: "Marathon Digital" },
      { ticker: "CLSK",     name: "CleanSpark" },
    ],
  },
  {
    label: "HIGH MOMENTUM",
    color: "#a855f7",
    tickers: [
      { ticker: "SMCI", name: "Super Micro" },
      { ticker: "ARM",  name: "ARM Holdings" },
      { ticker: "RKLB", name: "Rocket Lab" },
      { ticker: "IONQ", name: "IonQ" },
      { ticker: "RGTI", name: "Rigetti" },
      { ticker: "LUNR", name: "Intuitive Machines" },
      { ticker: "ACHR", name: "Archer Aviation" },
      { ticker: "SHOP", name: "Shopify" },
      { ticker: "SNOW", name: "Snowflake" },
      { ticker: "AI",   name: "C3.ai" },
      { ticker: "PATH", name: "UiPath" },
      { ticker: "SOUN", name: "SoundHound AI" },
      { ticker: "BBAI", name: "BigBear.ai" },
      { ticker: "QBTS", name: "D-Wave Quantum" },
      { ticker: "QUBT", name: "Quantum Computing" },
      { ticker: "BTDR", name: "Bitdeer" },
      { ticker: "CAVA", name: "CAVA Group" },
      { ticker: "DUOL", name: "Duolingo" },
      { ticker: "CELH", name: "Celsius Holdings" },
      { ticker: "UPST", name: "Upstart" },
      { ticker: "U",    name: "Unity Software" },
      { ticker: "CRSP", name: "CRISPR Therapeutics" },
      { ticker: "BEAM", name: "Beam Therapeutics" },
      { ticker: "CRDO", name: "Credo Technology" },
      { ticker: "APP",  name: "AppLovin" },
    ],
  },
  {
    label: "BONDS & MACRO",
    color: "#94a3b8",
    tickers: [
      { ticker: "TLT",  name: "20Y Treasuries" },
      { ticker: "IEF",  name: "7-10Y Treasuries" },
      { ticker: "SHY",  name: "1-3Y Treasuries" },
      { ticker: "GLD",  name: "Gold" },
      { ticker: "SLV",  name: "Silver" },
      { ticker: "GDX",  name: "Gold Miners" },
      { ticker: "USO",  name: "Crude Oil" },
      { ticker: "UNG",  name: "Natural Gas" },
      { ticker: "DXY",  name: "Dollar Index" },
      { ticker: "VIX",  name: "Volatility" },
      { ticker: "UVXY", name: "Short-Term VIX" },
      { ticker: "HYG",  name: "High Yield Bonds" },
      { ticker: "LQD",  name: "Corp Bonds" },
      { ticker: "EMB",  name: "EM Bonds" },
      { ticker: "PDBC", name: "Commodities" },
      { ticker: "BITO", name: "Bitcoin ETF" },
      { ticker: "IBIT", name: "iShares Bitcoin" },
      { ticker: "WEAT", name: "Wheat" },
      { ticker: "CORN", name: "Corn" },
    ],
  },
];

const ALL_TICKERS = GROUPS.flatMap(g => g.tickers.map(t => t.ticker));

// Color scale: -5% = deep red, 0% = neutral, +5% = deep green
function heatColor(pct: number) {
  const c = Math.max(-5, Math.min(5, pct));
  if (c >= 0) {
    const i = c / 5;
    return {
      bg: `rgba(0,${Math.round(160 + i * 95)},${Math.round(100 + i * 60)},${0.12 + i * 0.55})`,
      border: `rgba(0,229,160,${0.08 + i * 0.45})`,
      text: i > 0.3 ? "#00e5a0" : "#7a94b0",
    };
  } else {
    const i = Math.abs(c) / 5;
    return {
      bg: `rgba(${Math.round(180 + i * 75)},${Math.round(20 + i * 15)},${Math.round(20 + i * 15)},${0.12 + i * 0.55})`,
      border: `rgba(255,59,59,${0.08 + i * 0.45})`,
      text: i > 0.3 ? "#ff3b3b" : "#7a94b0",
    };
  }
}

function HeatCell({ ticker, name, quote, onClick, size }: {
  ticker: string; name: string; quote?: Quote; onClick: () => void; size: "md" | "sm";
}) {
  const pct = quote?.changePct ?? 0;
  const pos = pct >= 0;
  const { bg, border, text } = quote ? heatColor(pct) : { bg: "rgba(255,255,255,0.03)", border: "rgba(255,255,255,0.06)", text: "#374f68" };
  const h = size === "md" ? 90 : 72;

  return (
    <div onClick={onClick} style={{
      background: bg, border: `1px solid ${border}`,
      borderRadius: 4, padding: "10px 8px", cursor: "pointer",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      minHeight: h, transition: "opacity 0.15s", userSelect: "none",
    }}
      onMouseEnter={e => ((e.currentTarget as HTMLElement).style.opacity = "0.8")}
      onMouseLeave={e => ((e.currentTarget as HTMLElement).style.opacity = "1")}
    >
      <span style={{ fontFamily: "JetBrains Mono,monospace", fontWeight: 700, fontSize: size === "md" ? 13 : 11, color: "#dce8f5", marginBottom: 2, textAlign: "center" }}>
        {ticker.replace("-USD", "")}
      </span>
      <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "#4b6a8a", marginBottom: 4, textAlign: "center", lineHeight: 1.2 }}>
        {name}
      </span>
      {quote ? (
        <>
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontWeight: 700, fontSize: size === "md" ? 14 : 12, color: text }}>
            {pos ? "+" : ""}{pct.toFixed(2)}%
          </span>
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "#374f68", marginTop: 2 }}>
            ${quote.price < 1 ? quote.price.toFixed(4) : quote.price.toFixed(2)}
          </span>
        </>
      ) : (
        <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "#374f68" }}>—</span>
      )}
    </div>
  );
}

export default function HeatmapPage() {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      // Batch into chunks of 20
      const chunks: string[][] = [];
      for (let i = 0; i < ALL_TICKERS.length; i += 20) chunks.push(ALL_TICKERS.slice(i, i + 20));
      const results = await Promise.all(
        chunks.map(c => fetch(`/api/stocks?tickers=${c.join(",")}`).then(r => r.json()))
      );
      const merged: Record<string, Quote> = {};
      results.forEach(r => Object.assign(merged, r.quotes ?? {}));
      setQuotes(merged);
      setLastUpdate(new Date());
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, 1000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  // Market breadth summary
  const allQuotes = Object.values(quotes);
  const gainers = allQuotes.filter(q => q.changePct > 0).length;
  const losers  = allQuotes.filter(q => q.changePct < 0).length;
  const avgPct  = allQuotes.length ? allQuotes.reduce((s, q) => s + q.changePct, 0) / allQuotes.length : 0;

  const breadthColor = avgPct >= 0 ? "#00e5a0" : "#ff3b3b";

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1300, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div>
          <h1 className="gradient-text font-bold" style={{ fontSize: 22, marginBottom: 3 }}>Market Heatmap</h1>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
            Sectors · Mega Caps · Crypto · Momentum · Macro — 1s live
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Breadth bar */}
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "8px 14px", minWidth: 200 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "#374f68", letterSpacing: "0.08em" }}>MARKET BREADTH</span>
              <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700, color: breadthColor }}>
                {avgPct >= 0 ? "+" : ""}{avgPct.toFixed(2)}% avg
              </span>
            </div>
            <div style={{ height: 5, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{
                height: "100%", borderRadius: 3,
                width: `${gainers + losers > 0 ? (gainers / (gainers + losers)) * 100 : 50}%`,
                background: "linear-gradient(90deg, #00e5a0, #4b9eff)",
              }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
              <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "#00e5a0" }}>{gainers} up</span>
              <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "#ff3b3b" }}>{losers} down</span>
            </div>
          </div>
          {lastUpdate && (
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <Activity size={10} style={{ color: "#00e5a0" }} />
              <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "#374f68" }}>
                {lastUpdate.toLocaleTimeString()}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Color scale legend */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 16 }}>
        {[-5, -3, -1, 0, 1, 3, 5].map(v => {
          const { bg, text } = heatColor(v);
          return (
            <div key={v} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 28, height: 16, borderRadius: 2, background: bg }} />
              <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "#374f68" }}>
                {v > 0 ? `+${v}%` : `${v}%`}
              </span>
            </div>
          );
        })}
      </div>

      {loading && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60, gap: 10, color: "#374f68" }}>
          <RefreshCw size={16} className="animate-spin" style={{ color: "#00e5a0" }} />
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 12 }}>Loading market data…</span>
        </div>
      )}

      {/* Groups */}
      {!loading && GROUPS.map(group => (
        <div key={group.label} style={{ marginBottom: 20 }}>
          <div style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
            letterSpacing: "0.12em", color: group.color, marginBottom: 8,
            paddingBottom: 6, borderBottom: `1px solid ${group.color}22`,
          }}>
            {group.label}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 6 }}>
            {group.tickers.map(({ ticker, name }) => (
              <HeatCell
                key={ticker}
                ticker={ticker}
                name={name}
                quote={quotes[ticker]}
                onClick={() => setSelectedTicker(ticker)}
                size={group.label === "S&P 500 SECTORS" || group.label === "BONDS & MACRO" ? "md" : "sm"}
              />
            ))}
          </div>
        </div>
      ))}

      <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "#374f68", textAlign: "center", marginTop: 8 }}>
        Data: Yahoo Finance · 1s auto-refresh · Click any cell to view chart · Not financial advice
      </p>

      {selectedTicker && (
        <SymbolModal ticker={selectedTicker} onClose={() => setSelectedTicker(null)} />
      )}
    </div>
  );
}
