"use client";
import { useEffect, useState, useCallback } from "react";
import { WHALE_WALLETS, WhaleWallet } from "@/lib/data";
import { CheckCircle, AlertCircle, Copy, ExternalLink, TrendingUp, TrendingDown, X, RefreshCw, Activity } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface WalletData extends WhaleWallet {
  balance: number;
  balanceUsd: number;
  price: number;
  priceChange?: number;
  balanceLive: boolean;
}
interface Prices { btc: number; eth: number; btcChange: number; ethChange: number }

const CHAIN_COLORS: Record<string, string> = { BTC: "#f7931a", ETH: "#627eea" };
const CHAIN_EXPLORERS: Record<string, (a: string) => string> = {
  BTC: a => `https://blockstream.info/address/${a}`,
  ETH: a => `https://etherscan.io/address/${a}`,
};

function fmtUsd(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(2)}`;
}
function fmtBalance(n: number, chain: string) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M ${chain}`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K ${chain}`;
  return `${n.toFixed(4)} ${chain}`;
}

// ── Wallet detail panel ──────────────────────────────────────────────────────
function WalletDetail({ wallet, prices, onClose }: { wallet: WalletData; prices: Prices; onClose: () => void }) {
  const chainColor = CHAIN_COLORS[wallet.chain] ?? "#94a3b8";
  const explorerUrl = CHAIN_EXPLORERS[wallet.chain]?.(wallet.address) ?? "#";
  const priceChange = wallet.chain === "BTC" ? prices.btcChange : prices.ethChange;
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const metrics = [
    { label: "BALANCE (USD)", value: fmtUsd(wallet.balanceUsd), color: "var(--text-primary)" },
    { label: "BALANCE (NATIVE)", value: fmtBalance(wallet.balance, wallet.chain), color: chainColor },
    { label: `${wallet.chain} PRICE`, value: `$${wallet.price.toLocaleString()}`, color: "var(--text-primary)" },
    { label: "24H CHANGE", value: `${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`, color: priceChange >= 0 ? "var(--green)" : "var(--red)" },
    { label: "STATUS", value: wallet.balanceLive ? "LIVE" : "ESTIMATED", color: wallet.balanceLive ? "var(--green)" : "var(--gold)" },
    { label: "VERIFIED", value: wallet.verified ? "YES" : "UNCONFIRMED", color: wallet.verified ? "var(--green)" : "var(--gold)" },
  ];

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 50,
      background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }} onClick={onClose}>
      <div style={{
        background: "var(--bg-card)", border: "1px solid var(--border-light)",
        borderRadius: 6, width: "100%", maxWidth: 620, maxHeight: "90vh", overflow: "auto",
      }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="flex items-center gap-3">
            <div style={{ width: 40, height: 40, borderRadius: 6, background: chainColor + "22", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span className="mono font-bold text-sm" style={{ color: chainColor }}>{wallet.chain}</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold" style={{ fontSize: 16, color: "var(--text-primary)" }}>{wallet.name}</h2>
                {wallet.verified ? <CheckCircle size={14} style={{ color: "var(--green)" }} /> : <AlertCircle size={14} style={{ color: "var(--gold)" }} />}
              </div>
              <p className="mono text-xs" style={{ color: "var(--text-muted)" }}>{wallet.label}</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <div className="bb-header">WALLET OVERVIEW</div>

        {/* Metrics grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1, background: "var(--border)", margin: "0" }}>
          {metrics.map(m => (
            <div key={m.label} style={{ background: "var(--bg-card)", padding: "12px 16px" }}>
              <p className="stat-label" style={{ marginBottom: 4 }}>{m.label}</p>
              <p className="num font-bold" style={{ fontSize: 15, color: m.color }}>{m.value}</p>
            </div>
          ))}
        </div>

        <div className="bb-header" style={{ marginTop: 1 }}>WALLET ADDRESS</div>

        {/* Address */}
        <div style={{ padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 4 }}>
            <code className="mono flex-1 text-xs" style={{ color: "var(--text-secondary)", wordBreak: "break-all" }}>
              {wallet.address}
            </code>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={copy} style={{ background: "none", border: "none", cursor: "pointer", color: copied ? "var(--green)" : "var(--text-muted)", padding: 4 }}>
                <Copy size={13} />
              </button>
              <a href={explorerUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)", display: "flex" }}>
                <ExternalLink size={13} />
              </a>
            </div>
          </div>
          {copied && <p className="mono text-xs mt-1" style={{ color: "var(--green)" }}>Copied to clipboard</p>}
        </div>

        <div className="bb-header">NOTES</div>
        <div style={{ padding: "12px 16px" }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>{wallet.notes}</p>
        </div>

        {/* Footer */}
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between" }}>
          <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>
            Balance source: {wallet.chain === "BTC" ? "Blockstream" : "Blockscout"} · {wallet.balanceLive ? "Live" : "Estimated"}
          </span>
          <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
            className="mono text-xs flex items-center gap-1 hover:underline" style={{ color: "var(--blue)" }}>
            View on explorer <ExternalLink size={10} />
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Wallet card ──────────────────────────────────────────────────────────────
function WalletCard({ wallet, prices, onClick }: { wallet: WalletData; prices: Prices; onClick: () => void }) {
  const chainColor = CHAIN_COLORS[wallet.chain] ?? "#94a3b8";
  const priceChange = wallet.chain === "BTC" ? prices.btcChange : prices.ethChange;
  const [copied, setCopied] = useState(false);

  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div onClick={onClick} style={{
      background: "var(--bg-card)", border: "1px solid var(--border)",
      borderRadius: 4, cursor: "pointer", transition: "all 0.15s",
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border-accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-card)"; }}
    >
      {/* Top bar */}
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div className="flex items-center gap-2.5">
          <div style={{ width: 36, height: 36, borderRadius: 4, background: chainColor + "20", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span className="mono font-bold text-xs" style={{ color: chainColor }}>{wallet.chain}</span>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>{wallet.name}</h3>
              {wallet.verified ? <CheckCircle size={11} style={{ color: "var(--green)" }} /> : <AlertCircle size={11} style={{ color: "var(--gold)" }} />}
            </div>
            <p className="mono text-xs" style={{ color: "var(--text-muted)" }}>{wallet.label}</p>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {wallet.balanceLive && (
            <div className="flex items-center gap-1 justify-end mb-1">
              <div className="pulse-dot" style={{ width: 5, height: 5 }} />
              <span className="mono text-xs" style={{ color: "var(--green)" }}>live</span>
            </div>
          )}
          <p className="num font-bold" style={{ fontSize: 17, color: "var(--text-primary)" }}>{fmtUsd(wallet.balanceUsd)}</p>
          <p className="num text-xs" style={{ color: "var(--text-secondary)" }}>{fmtBalance(wallet.balance, wallet.chain)}</p>
        </div>
      </div>

      {/* Address */}
      <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 6, borderBottom: "1px solid var(--border)" }}>
        <code className="mono text-xs flex-1 truncate" style={{ color: "var(--text-muted)" }}>{wallet.address}</code>
        <button onClick={copy} style={{ background: "none", border: "none", cursor: "pointer", color: copied ? "var(--green)" : "var(--text-muted)", padding: 2, flexShrink: 0 }}>
          <Copy size={11} />
        </button>
        <a href={CHAIN_EXPLORERS[wallet.chain]?.(wallet.address) ?? "#"} target="_blank" rel="noopener noreferrer"
          onClick={e => e.stopPropagation()} style={{ color: "var(--text-muted)", display: "flex", flexShrink: 0 }}>
          <ExternalLink size={11} />
        </a>
      </div>

      {/* Footer */}
      <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="flex items-center gap-1.5">
          {priceChange >= 0 ? <TrendingUp size={11} style={{ color: "var(--green)" }} /> : <TrendingDown size={11} style={{ color: "var(--red)" }} />}
          <span className="num text-xs" style={{ color: priceChange >= 0 ? "var(--green)" : "var(--red)" }}>
            {priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)}% 24h
          </span>
          <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>· ${wallet.price.toLocaleString()}</span>
        </div>
        <span className={`tag ${wallet.verified ? "tag-buy" : "tag-hold"}`} style={{ fontSize: 9 }}>
          {wallet.verified ? "VERIFIED" : "UNCONFIRMED"}
        </span>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function WhalesPage() {
  const [wallets, setWallets] = useState<WalletData[]>([]);
  const [prices, setPrices] = useState<Prices>({ btc: 78000, eth: 2300, btcChange: 0, ethChange: 0 });
  const [loading, setLoading] = useState(true);
  const [chainFilter, setChainFilter] = useState("All");
  const [selected, setSelected] = useState<WalletData | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchData = useCallback(() => {
    fetch("/api/whales")
      .then(r => r.json())
      .then(d => {
        setWallets(d.wallets ?? []);
        setPrices(d.prices ?? { btc: 78000, eth: 2300, btcChange: 0, ethChange: 0 });
        setLastUpdate(new Date());
      })
      .catch(() => {
        setWallets(WHALE_WALLETS.map(w => ({
          ...w, balance: w.knownBalance ?? 0,
          balanceUsd: (w.knownBalance ?? 0) * (w.chain === "BTC" ? 78000 : 2300),
          price: w.chain === "BTC" ? 78000 : 2300, balanceLive: false,
        })));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const iv = setInterval(fetchData, 1000);
    return () => clearInterval(iv);
  }, [fetchData]);

  const filtered = chainFilter === "All" ? wallets : wallets.filter(w => w.chain === chainFilter);
  const totalUsd  = filtered.reduce((s, w) => s + w.balanceUsd, 0);

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1200, margin: "0 auto" }}>
      {selected && (
        <WalletDetail wallet={selected} prices={prices} onClose={() => setSelected(null)} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="gradient-text font-bold mb-0.5" style={{ fontSize: 22 }}>Crypto Whale Wallets</h1>
          <p className="mono text-xs" style={{ color: "var(--text-muted)" }}>
            Known public wallets · Blockstream (BTC) · Blockscout (ETH) · 1s refresh
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <p className="stat-label">TRACKED VALUE</p>
          <p className="num font-bold" style={{ fontSize: 22, color: "var(--text-primary)" }}>{fmtUsd(totalUsd)}</p>
          {lastUpdate && <p className="mono text-xs" style={{ color: "var(--text-muted)" }}>Updated {formatDistanceToNow(lastUpdate, { addSuffix: true })}</p>}
        </div>
      </div>

      {/* Price bar + filter */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex gap-2">
          {["All", "BTC", "ETH"].map(c => (
            <button key={c} onClick={() => setChainFilter(c)} className="mono font-semibold text-xs px-3 py-1.5 transition-all" style={{
              background: chainFilter === c ? "rgba(0,229,160,0.1)" : "var(--bg-card)",
              border: `1px solid ${chainFilter === c ? "rgba(0,229,160,0.3)" : "var(--border)"}`,
              borderRadius: 3, color: chainFilter === c ? "var(--green)" : "var(--text-secondary)", cursor: "pointer",
            }}>{c === "All" ? "ALL CHAINS" : c}</button>
          ))}
        </div>
        <div className="flex gap-3">
          {[
            { chain: "BTC", price: prices.btc, change: prices.btcChange, symbol: "₿" },
            { chain: "ETH", price: prices.eth, change: prices.ethChange, symbol: "Ξ" },
          ].map(({ chain, price, change, symbol }) => (
            <div key={chain} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "8px 14px", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: CHAIN_COLORS[chain], fontSize: 16, fontWeight: 700 }}>{symbol}</span>
              <div>
                <p className="num font-bold text-sm" style={{ color: "var(--text-primary)" }}>${price.toLocaleString()}</p>
                <p className="num text-xs" style={{ color: change >= 0 ? "var(--green)" : "var(--red)" }}>
                  {change >= 0 ? "+" : ""}{change.toFixed(2)}% 24h
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 80, gap: 10 }}>
          <RefreshCw size={18} className="animate-spin" style={{ color: "var(--green)" }} />
          <span className="mono text-sm" style={{ color: "var(--text-muted)" }}>Fetching on-chain balances…</span>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
          {filtered.map(w => (
            <WalletCard key={w.id} wallet={w} prices={prices} onClick={() => setSelected(w)} />
          ))}
        </div>
      )}

      <p className="mono text-xs mt-5 text-center" style={{ color: "var(--text-muted)" }}>
        All wallets use publicly known or disclosed addresses · Not financial advice · Click any wallet for details
      </p>
    </div>
  );
}
