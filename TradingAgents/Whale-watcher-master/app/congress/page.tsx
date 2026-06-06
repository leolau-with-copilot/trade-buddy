"use client";
import { useEffect, useState, useMemo, useCallback } from "react";
import { Search, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import { CONGRESS_FALLBACK, amountMidpoint, partyColor } from "@/lib/data";
import { format, parseISO, formatDistanceToNow } from "date-fns";
import CongressMemberModal from "@/components/CongressMemberModal";

interface Trade {
  id: string;
  representative: string;
  party: "D" | "R" | "I";
  state: string;
  chamber?: string;
  ticker: string;
  assetName: string;
  type: "purchase" | "sale";
  amount: string;
  transactionDate: string;
  disclosureDate: string;
  sector?: string;
  excessReturn?: number | null;
  priceChange?: number | null;
}

const TYPES   = ["All", "Purchase", "Sale"];
const PARTIES = ["All", "D", "R", "I"];
const CHAMBERS = ["All", "Representatives", "Senate"];

function safeDate(s: string) {
  try { return format(parseISO(s), "MMM d, yyyy"); } catch { return s; }
}
function safeDist(s: string) {
  try { return formatDistanceToNow(parseISO(s), { addSuffix: true }); } catch { return ""; }
}

export default function CongressPage() {
  const [trades, setTrades] = useState<Trade[]>(CONGRESS_FALLBACK as Trade[]);
  const [source, setSource] = useState("fallback");
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState("");
  const [type, setType]       = useState("All");
  const [party, setParty]     = useState("All");
  const [chamber, setChamber] = useState("All");
  const [sort, setSort]       = useState<"date" | "amount" | "alpha">("date");
  const [selectedMember, setSelectedMember] = useState<string | null>(null);

  const fetchTrades = useCallback(() => {
    fetch("/api/congress")
      .then(r => r.json())
      .then(d => { setTrades(d.trades); setSource(d.source); setProvider(d.provider ?? ""); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchTrades();
    const iv = setInterval(fetchTrades, 30000); // Congress disclosures don't change every 5s
    return () => clearInterval(iv);
  }, [fetchTrades]);

  const filtered = useMemo(() => {
    let t = trades;
    if (search) {
      const q = search.toLowerCase();
      t = t.filter(x =>
        x.representative.toLowerCase().includes(q) ||
        x.ticker.toLowerCase().includes(q) ||
        x.assetName.toLowerCase().includes(q)
      );
    }
    if (type !== "All")    t = t.filter(x => x.type === type.toLowerCase());
    if (party !== "All")   t = t.filter(x => x.party === party);
    if (chamber !== "All") t = t.filter(x => x.chamber === chamber);
    if (sort === "amount") t = [...t].sort((a, b) => amountMidpoint(b.amount) - amountMidpoint(a.amount));
    else if (sort === "alpha") t = [...t].sort((a, b) => a.representative.localeCompare(b.representative));
    else t = [...t].sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
    return t;
  }, [trades, search, type, party, chamber, sort]);

  const buyCount  = filtered.filter(t => t.type === "purchase").length;
  const sellCount = filtered.filter(t => t.type === "sale").length;
  const buyVol    = filtered.filter(t => t.type === "purchase").reduce((s, t) => s + amountMidpoint(t.amount), 0);
  const sellVol   = filtered.filter(t => t.type === "sale").reduce((s, t) => s + amountMidpoint(t.amount), 0);
  const fmtVol = (n: number) => n >= 1e6 ? `$${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(0)}K` : `$${n}`;

  // Latest trade date for freshness indicator
  const latestDate = trades.length > 0 ? trades[0].disclosureDate : "";

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold gradient-text mb-1">Congress Stock Trades</h1>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Mandatory STOCK Act disclosures ·{" "}
            {source === "live" ? (
              <span style={{ color: "var(--green)" }}>
                Live via {provider} {latestDate && `· Latest: ${safeDate(latestDate)}`}
              </span>
            ) : (
              <span style={{ color: "var(--gold)" }}>Cached fallback data</span>
            )}
          </p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <div className="card px-4 py-2 flex items-center gap-2">
            <TrendingUp size={14} style={{ color: "var(--green)" }} />
            <span className="num font-semibold" style={{ color: "var(--green)" }}>
              {buyCount} buys · {fmtVol(buyVol)}
            </span>
          </div>
          <div className="card px-4 py-2 flex items-center gap-2">
            <TrendingDown size={14} style={{ color: "var(--red)" }} />
            <span className="num font-semibold" style={{ color: "var(--red)" }}>
              {sellCount} sells · {fmtVol(sellVol)}
            </span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 mb-5 flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-2 flex-1 min-w-44 px-3 py-2 rounded-lg" style={{ background: "var(--bg-hover)", border: "1px solid var(--border)" }}>
          <Search size={14} style={{ color: "var(--text-muted)" }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search member or ticker…"
            className="bg-transparent text-sm flex-1 outline-none"
            style={{ color: "var(--text-primary)" }}
          />
        </div>
        {[
          { val: type,    set: setType,    opts: TYPES,    labels: { All:"All types", Purchase:"Buys", Sale:"Sells" } },
          { val: party,   set: setParty,   opts: PARTIES,  labels: { All:"All parties", D:"Democrat", R:"Republican", I:"Independent" } },
          { val: chamber, set: setChamber, opts: CHAMBERS, labels: { All:"All chambers", Representatives:"House", Senate:"Senate" } },
        ].map(({ val, set, opts, labels }) => (
          <select
            key={opts[0]}
            value={val}
            onChange={e => set(e.target.value as any)}
            className="text-sm px-3 py-2 rounded-lg outline-none"
            style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
          >
            {opts.map(o => <option key={o} value={o}>{(labels as any)[o] ?? o}</option>)}
          </select>
        ))}
        <select value={sort} onChange={e => setSort(e.target.value as any)} className="text-sm px-3 py-2 rounded-lg outline-none" style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text-primary)" }}>
          <option value="date">Sort: Latest first</option>
          <option value="amount">Sort: Largest trade</option>
          <option value="alpha">Sort: A–Z member</option>
        </select>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-3 py-16" style={{ color: "var(--text-muted)" }}>
            <RefreshCw size={18} className="animate-spin" style={{ color: "var(--green)" }} />
            <span>Loading live Congress trades…</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Member", "Ticker / Asset", "Type", "Amount", "Traded", "Disclosed", "vs SPY"].map((h, i) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-left"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-12" style={{ color: "var(--text-muted)" }}>No trades match your filters.</td></tr>
                ) : filtered.map(t => {
                  const isBuy = t.type === "purchase";
                  const hasAlpha = t.excessReturn != null;
                  const alphaPct = t.excessReturn ?? 0;
                  return (
                    <tr key={t.id} className="border-b hover:bg-white/[0.02] transition-colors" style={{ borderColor: "var(--border)" }}>
                      {/* Member */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold px-1.5 py-0.5 rounded shrink-0" style={{ background: partyColor(t.party) + "22", color: partyColor(t.party) }}>{t.party}</span>
                          <div>
                            <button
                              onClick={() => setSelectedMember(t.representative)}
                              className="font-medium whitespace-nowrap hover:underline text-left"
                              style={{ color: "var(--green)", cursor: "pointer", background: "none", border: "none", padding: 0 }}
                            >{t.representative}</button>
                            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                              {t.state || ""}{t.chamber === "Senate" ? " · Senate" : ""}
                            </p>
                          </div>
                        </div>
                      </td>
                      {/* Ticker */}
                      <td className="px-4 py-3">
                        {t.ticker && t.ticker !== "--" ? (
                          <a href={`https://finance.yahoo.com/quote/${t.ticker}`} target="_blank" rel="noopener noreferrer"
                            className="font-mono font-bold hover:underline" style={{ color: "var(--text-primary)" }}>
                            {t.ticker}
                          </a>
                        ) : (
                          <span className="font-mono text-xs" style={{ color: "var(--text-muted)" }}>—</span>
                        )}
                        <p className="text-xs truncate max-w-44" style={{ color: "var(--text-muted)" }}>{t.assetName}</p>
                      </td>
                      {/* Type */}
                      <td className="px-4 py-3">
                        <span className={`tag ${isBuy ? "tag-buy" : "tag-sell"}`}>
                          {isBuy ? "BUY" : "SELL"}
                        </span>
                      </td>
                      {/* Amount */}
                      <td className="px-4 py-3 num text-xs" style={{ color: "var(--text-secondary)" }}>{t.amount}</td>
                      {/* Traded */}
                      <td className="px-4 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
                        <span className="num">{safeDate(t.transactionDate)}</span>
                        <p className="text-xs" style={{ color: "var(--text-muted)" }}>{safeDist(t.transactionDate)}</p>
                      </td>
                      {/* Disclosed */}
                      <td className="px-4 py-3 num text-xs" style={{ color: "var(--text-muted)" }}>{safeDate(t.disclosureDate)}</td>
                      {/* vs SPY */}
                      <td className="px-4 py-3">
                        {hasAlpha ? (
                          <span className="num text-xs font-semibold" style={{ color: alphaPct >= 0 ? "var(--green)" : "var(--red)" }}>
                            {alphaPct >= 0 ? "+" : ""}{alphaPct.toFixed(1)}%
                          </span>
                        ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-4 py-3 border-t flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>{filtered.length} trades · {trades.length} total</span>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Source: {provider || "STOCK Act"} · Not financial advice
          </span>
        </div>
      </div>

      {selectedMember && (
        <CongressMemberModal
          member={selectedMember}
          trades={trades.filter(t => t.representative === selectedMember)}
          partyColor={partyColor}
          amountMidpoint={amountMidpoint}
          onClose={() => setSelectedMember(null)}
        />
      )}
    </div>
  );
}
