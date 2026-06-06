"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Search, Star, StarOff, RefreshCw, X, TrendingUp, TrendingDown, Activity, UserPlus } from "lucide-react";
import { CONGRESS_FALLBACK, amountMidpoint, partyColor } from "@/lib/data";
import { formatDistanceToNow, parseISO } from "date-fns";
import CongressMemberModal from "@/components/CongressMemberModal";

interface Trade {
  id: string; representative: string; party: "D"|"R"|"I"; state: string;
  chamber?: string; ticker: string; assetName: string; type: "purchase"|"sale";
  amount: string; transactionDate: string; disclosureDate: string;
  sector?: string; excessReturn?: number|null;
}

const LS_KEY = "ww-members";

function fmtVal(n: number) {
  if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`;
  return `$${n}`;
}
function safeAgo(s: string) {
  try { return formatDistanceToNow(parseISO(s), { addSuffix: true }); } catch { return ""; }
}

// ── Per-member stats ─────────────────────────────────────────────────────
function calcStats(trades: Trade[]) {
  const buys  = trades.filter(t => t.type === "purchase");
  const sells = trades.filter(t => t.type === "sale");
  const buyVol  = buys.reduce((s, t) => s + amountMidpoint(t.amount), 0);
  const sellVol = sells.reduce((s, t) => s + amountMidpoint(t.amount), 0);

  // Top ticker
  const tickerMap: Record<string, number> = {};
  trades.forEach(t => { if (t.ticker && t.ticker !== "--") tickerMap[t.ticker] = (tickerMap[t.ticker] ?? 0) + 1; });
  const topTicker = Object.entries(tickerMap).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // vs SPY
  const withAlpha = trades.filter(t => t.excessReturn != null);
  const avgAlpha = withAlpha.length
    ? withAlpha.reduce((s, t) => s + (t.excessReturn ?? 0), 0) / withAlpha.length
    : null;

  // Latest trade
  const sorted = [...trades].sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
  const latest = sorted[0] ?? null;

  return { buys: buys.length, sells: sells.length, buyVol, sellVol, topTicker, avgAlpha, latest, total: trades.length };
}

// ── Member card ──────────────────────────────────────────────────────────
function MemberCard({ name, trades, onOpen, onRemove }: {
  name: string; trades: Trade[]; onOpen: () => void; onRemove: () => void;
}) {
  const m = trades[0];
  const pc = m ? partyColor(m.party) : "#94a3b8";
  const s = useMemo(() => calcStats(trades), [trades]);
  const sentiment = s.buys >= s.sells ? "bullish" : "bearish";

  return (
    <div style={{
      background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4,
      overflow: "hidden", position: "relative", transition: "border-color 0.15s",
    }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--border-light)")}
      onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--border)")}
    >
      {/* Remove button */}
      <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{
        position: "absolute", top: 8, right: 8, background: "none", border: "none",
        cursor: "pointer", color: "var(--text-muted)", padding: 4, zIndex: 1,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <X size={12} />
      </button>

      {/* Header */}
      <div onClick={onOpen} style={{ padding: "14px 14px 10px", cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{
            fontFamily: "JetBrains Mono,monospace", fontWeight: 700, fontSize: 10,
            padding: "2px 6px", borderRadius: 3,
            background: pc + "22", color: pc, border: `1px solid ${pc}44`,
          }}>{m?.party}</span>
          {m?.chamber && (
            <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)" }}>
              {m.chamber === "Senate" ? "SENATE" : "HOUSE"}
            </span>
          )}
        </div>
        <p style={{ fontWeight: 700, fontSize: 14, color: "var(--text-primary)", marginBottom: 2, paddingRight: 20 }}>{name}</p>
        <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)" }}>
          {m?.state ?? ""}
        </p>
      </div>

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
        {[
          { label: "TRADES", value: String(s.total), color: "var(--text-primary)" },
          { label: "BUYS", value: String(s.buys), color: "var(--green)" },
          { label: "SELLS", value: String(s.sells), color: "var(--red)" },
        ].map(stat => (
          <div key={stat.label} style={{ padding: "8px 10px", borderRight: "1px solid var(--border)" }}>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 2 }}>{stat.label}</p>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontWeight: 700, fontSize: 14, color: stat.color }}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Bottom */}
      <div onClick={onOpen} style={{ padding: "10px 14px", cursor: "pointer" }}>
        {/* Buy/sell bar */}
        <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 8 }}>
          <div style={{ flex: 1, height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 2,
              width: s.total ? `${(s.buys / s.total) * 100}%` : "50%",
              background: "linear-gradient(90deg, var(--green), #00b37a)",
            }} />
          </div>
          <span style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
            color: sentiment === "bullish" ? "var(--green)" : "var(--red)",
          }}>
            {sentiment === "bullish" ? "▲ BULLISH" : "▼ BEARISH"}
          </span>
        </div>

        {/* Volume + alpha */}
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <div>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "var(--text-muted)", marginBottom: 1 }}>VOLUME (EST.)</p>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontWeight: 700, color: "var(--text-secondary)" }}>
              {fmtVal(s.buyVol + s.sellVol)}
            </p>
          </div>
          {s.avgAlpha != null && (
            <div style={{ textAlign: "right" }}>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, color: "var(--text-muted)", marginBottom: 1 }}>AVG VS SPY</p>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontWeight: 700, color: s.avgAlpha >= 0 ? "var(--green)" : "var(--red)" }}>
                {s.avgAlpha >= 0 ? "+" : ""}{s.avgAlpha.toFixed(1)}%
              </p>
            </div>
          )}
        </div>

        {/* Top ticker + latest */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {s.topTicker && (
            <span style={{
              fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
              padding: "2px 7px", borderRadius: 3,
              background: "rgba(0,229,160,0.08)", color: "var(--green)",
              border: "1px solid rgba(0,229,160,0.2)",
            }}>↑ {s.topTicker}</span>
          )}
          {s.latest && (
            <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)" }}>
              Last: {safeAgo(s.latest.transactionDate)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Search result row ─────────────────────────────────────────────────────
function SearchRow({ name, party, state, chamber, followed, onToggle }: {
  name: string; party: string; state: string; chamber?: string;
  followed: boolean; onToggle: () => void;
}) {
  const pc = partyColor(party as any);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 14px",
      borderBottom: "1px solid var(--border)", cursor: "pointer",
      background: followed ? "rgba(0,229,160,0.04)" : "none",
    }}
      onClick={onToggle}
      onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.03)")}
      onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = followed ? "rgba(0,229,160,0.04)" : "none")}
    >
      <span style={{
        fontFamily: "JetBrains Mono,monospace", fontWeight: 700, fontSize: 9,
        padding: "1px 5px", borderRadius: 3,
        background: pc + "22", color: pc, border: `1px solid ${pc}44`,
        flexShrink: 0,
      }}>{party}</span>
      <div style={{ flex: 1 }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{name}</p>
        <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)" }}>
          {state}{chamber === "Senate" ? " · Senate" : " · House"}
        </p>
      </div>
      <div style={{ flexShrink: 0, color: followed ? "var(--green)" : "var(--text-muted)" }}>
        {followed ? <Star size={14} fill="currentColor" /> : <UserPlus size={14} />}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function MembersPage() {
  const [allTrades, setAllTrades]   = useState<Trade[]>(CONGRESS_FALLBACK as Trade[]);
  const [followed, setFollowed]     = useState<string[]>([]);
  const [search, setSearch]         = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [loading, setLoading]       = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [selectedMember, setSelectedMember] = useState<string | null>(null);

  // Load followed from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) setFollowed(JSON.parse(saved));
    } catch {}
  }, []);

  // Persist followed
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(followed)); } catch {}
  }, [followed]);

  const fetchTrades = useCallback(() => {
    fetch("/api/congress")
      .then(r => r.json())
      .then(d => { setAllTrades(d.trades); setLastUpdate(new Date()); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchTrades();
    const iv = setInterval(fetchTrades, 30000);
    return () => clearInterval(iv);
  }, [fetchTrades]);

  // All unique members from trades
  const allMembers = useMemo(() => {
    const map: Record<string, { party: string; state: string; chamber?: string }> = {};
    allTrades.forEach(t => {
      if (!map[t.representative]) {
        map[t.representative] = { party: t.party, state: t.state, chamber: t.chamber };
      }
    });
    return Object.entries(map).map(([name, info]) => ({ name, ...info }));
  }, [allTrades]);

  // Trades per member
  const tradesByMember = useMemo(() => {
    const map: Record<string, Trade[]> = {};
    allTrades.forEach(t => {
      if (!map[t.representative]) map[t.representative] = [];
      map[t.representative].push(t);
    });
    return map;
  }, [allTrades]);

  // Search results (not already followed)
  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return allMembers
      .filter(m => m.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [allMembers, search]);

  function toggleFollow(name: string) {
    setFollowed(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    );
  }

  const followedWithTrades = followed.map(name => ({
    name,
    trades: tradesByMember[name] ?? [],
  }));

  // Summary stats
  const totalTrades = followedWithTrades.reduce((s, m) => s + m.trades.length, 0);
  const totalBuys   = followedWithTrades.reduce((s, m) => s + m.trades.filter(t => t.type === "purchase").length, 0);
  const totalSells  = totalTrades - totalBuys;

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 className="gradient-text font-bold" style={{ fontSize: 22, marginBottom: 3 }}>Member Watchlist</h1>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
            Follow Congress members · Track their trades · 30s live refresh
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {lastUpdate && (
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <Activity size={10} style={{ color: "var(--green)" }} />
              <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)" }}>
                {lastUpdate.toLocaleTimeString()} · 30s
              </span>
            </div>
          )}
          <button onClick={() => setShowSearch(s => !s)} style={{
            display: "flex", alignItems: "center", gap: 6,
            fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
            padding: "6px 14px", borderRadius: 3, cursor: "pointer",
            background: showSearch ? "rgba(0,229,160,0.12)" : "rgba(0,229,160,0.08)",
            border: "1px solid rgba(0,229,160,0.3)", color: "var(--green)",
          }}>
            <UserPlus size={13} /> FOLLOW MEMBER
          </button>
        </div>
      </div>

      {/* Summary bar — only when following someone */}
      {followed.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
          {[
            { label: "FOLLOWING", value: String(followed.length), color: "var(--blue)" },
            { label: "TOTAL TRADES", value: String(totalTrades), color: "var(--text-primary)" },
            { label: "BUYS", value: String(totalBuys), color: "var(--green)" },
            { label: "SELLS", value: String(totalSells), color: "var(--red)" },
          ].map(s => (
            <div key={s.label} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "10px 14px" }}>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 8, letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 3 }}>{s.label}</p>
              <p style={{ fontFamily: "JetBrains Mono,monospace", fontWeight: 700, fontSize: 20, color: s.color }}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Search panel */}
      {showSearch && (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, marginBottom: 16, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
            <Search size={13} style={{ color: "var(--text-muted)" }} />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search any Congress member…"
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                fontFamily: "JetBrains Mono,monospace", fontSize: 12,
                color: "var(--text-primary)",
              }}
            />
            {search && (
              <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex" }}>
                <X size={12} />
              </button>
            )}
          </div>
          {searchResults.length > 0 ? (
            searchResults.map(m => (
              <SearchRow
                key={m.name}
                name={m.name} party={m.party} state={m.state} chamber={m.chamber}
                followed={followed.includes(m.name)}
                onToggle={() => toggleFollow(m.name)}
              />
            ))
          ) : search ? (
            <p style={{ padding: "16px 14px", fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
              No members found for "{search}"
            </p>
          ) : (
            <div>
              <p style={{ padding: "10px 14px 4px", fontFamily: "JetBrains Mono,monospace", fontSize: 9, letterSpacing: "0.08em", color: "var(--text-muted)" }}>
                MOST ACTIVE MEMBERS
              </p>
              {allMembers
                .map(m => ({ ...m, count: tradesByMember[m.name]?.length ?? 0 }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 8)
                .map(m => (
                  <SearchRow
                    key={m.name}
                    name={m.name} party={m.party} state={m.state} chamber={m.chamber}
                    followed={followed.includes(m.name)}
                    onToggle={() => toggleFollow(m.name)}
                  />
                ))}
            </div>
          )}
        </div>
      )}

      {/* Member cards grid */}
      {loading && followed.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60, gap: 10, color: "var(--text-muted)" }}>
          <RefreshCw size={16} className="animate-spin" style={{ color: "var(--green)" }} />
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 12 }}>Loading trades…</span>
        </div>
      ) : followed.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <Star size={36} style={{ color: "var(--text-muted)", margin: "0 auto 14px" }} />
          <p style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No members followed yet</p>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)", marginBottom: 16 }}>
            Click "Follow Member" above to start tracking Congress members
          </p>
          <button onClick={() => setShowSearch(true)} style={{
            fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
            padding: "8px 18px", borderRadius: 3, cursor: "pointer",
            background: "rgba(0,229,160,0.12)", border: "1px solid rgba(0,229,160,0.3)", color: "var(--green)",
          }}>
            + Browse Members
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
          {followedWithTrades.map(({ name, trades }) => (
            <MemberCard
              key={name}
              name={name}
              trades={trades}
              onOpen={() => setSelectedMember(name)}
              onRemove={() => toggleFollow(name)}
            />
          ))}
        </div>
      )}

      {/* Latest trades from followed members */}
      {followed.length > 0 && totalTrades > 0 && (
        <div style={{ marginTop: 24, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-muted)", padding: "8px 14px", borderBottom: "1px solid var(--border)", background: "var(--bg-secondary)", textTransform: "uppercase" }}>
            Latest Trades from Followed Members
          </div>
          {followedWithTrades
            .flatMap(m => m.trades.map(t => ({ ...t, _name: m.name })))
            .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))
            .slice(0, 15)
            .map(t => {
              const isBuy = t.type === "purchase";
              const pc = partyColor(t.party);
              return (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: pc + "22", color: pc, border: `1px solid ${pc}44`, flexShrink: 0 }}>{t.party}</span>
                  <button onClick={() => setSelectedMember(t.representative)} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: "var(--green)", background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left", flexShrink: 0 }}>
                    {t.representative}
                  </button>
                  <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700, color: "var(--text-primary)", flexShrink: 0 }}>
                    {t.ticker && t.ticker !== "--" ? t.ticker : t.assetName?.slice(0, 18)}
                  </span>
                  <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: isBuy ? "rgba(0,229,160,0.12)" : "rgba(255,59,59,0.12)", color: isBuy ? "var(--green)" : "var(--red)", border: `1px solid ${isBuy ? "rgba(0,229,160,0.25)" : "rgba(255,59,59,0.25)"}`, flexShrink: 0 }}>
                    {isBuy ? "BUY" : "SELL"}
                  </span>
                  <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)", flex: 1 }}>{t.amount}</span>
                  <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{safeAgo(t.transactionDate)}</span>
                  {t.excessReturn != null && (
                    <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700, color: t.excessReturn >= 0 ? "var(--green)" : "var(--red)", flexShrink: 0 }}>
                      {t.excessReturn >= 0 ? "+" : ""}{t.excessReturn.toFixed(1)}%
                    </span>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {selectedMember && (
        <CongressMemberModal
          member={selectedMember}
          trades={allTrades.filter(t => t.representative === selectedMember)}
          partyColor={partyColor}
          amountMidpoint={amountMidpoint}
          onClose={() => setSelectedMember(null)}
        />
      )}

      <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginTop: 16 }}>
        Watchlist saved locally · Data: QuiverQuant STOCK Act · Not financial advice
      </p>
    </div>
  );
}
