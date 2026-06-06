"use client";
import { useState, useMemo } from "react";
import { Calendar, Bell, TrendingUp, DollarSign, BarChart2, Cpu, Globe } from "lucide-react";

type EventType = "fomc" | "cpi" | "earnings" | "jobs" | "gdp" | "options" | "crypto" | "other";

interface CalEvent {
  date: string;       // YYYY-MM-DD
  time?: string;      // "08:30 ET"
  title: string;
  type: EventType;
  impact: "high" | "med" | "low";
  desc?: string;
  tickers?: string[];
}

const EVENTS: CalEvent[] = [
  // FOMC
  {
    date:"2026-05-07", time:"14:00 ET", title:"FOMC Rate Decision", type:"fomc", impact:"high",
    desc:"🎯 EXPECTED DECISION: Hold rates at 4.25–4.50% (CME FedWatch: ~95% probability of no change). Press conference at 14:30 ET. No updated dot plot at this meeting — next projections come in June. Watch Powell's language on inflation progress and labor market. A hawkish surprise (rate hike hint) would spike TLT lower; a dovish surprise (cut signal) would rally equities.",
    tickers:["SPY","TLT","GLD"]
  },
  {
    date:"2026-06-17", time:"14:00 ET", title:"FOMC Rate Decision", type:"fomc", impact:"high",
    desc:"🎯 EXPECTED DECISION: Hold at 4.25–4.50% with updated dot plot + economic projections. Market pricing ~25% chance of first cut by this meeting. The 2026 dot plot median will determine whether 1 or 2 cuts are signaled for H2 2026. GDP and inflation forecasts will also be revised. This is the most consequential FOMC of the year.",
    tickers:["SPY","TLT","QQQ"]
  },
  {
    date:"2026-07-29", time:"14:00 ET", title:"FOMC Rate Decision", type:"fomc", impact:"high",
    desc:"🎯 EXPECTED DECISION: Possible first cut to 4.00–4.25% if inflation data cooperates (market pricing ~40% probability by this date). No updated projections — next is September. If June CPI surprised to the downside, this is the meeting where a cut becomes live. A hold here with dovish language still rallies bonds.",
    tickers:["SPY","TLT"]
  },
  // CPI
  {
    date:"2026-05-13", time:"08:30 ET", title:"CPI — April Data", type:"cpi", impact:"high",
    desc:"📊 CONSENSUS FORECAST: Headline CPI +0.3% MoM / +2.6% YoY. Core CPI (ex-food & energy): +0.3% MoM / +3.1% YoY. Key drivers to watch: shelter costs (still elevated), services inflation, and used car prices. A hot print (Core >+0.4%) pushes rate cut odds to near-zero for 2026. A cool print (Core ≤+0.2%) rallies bonds and growth stocks sharply.",
    tickers:["SPY","TLT","GLD"]
  },
  {
    date:"2026-06-10", time:"08:30 ET", title:"CPI — May Data", type:"cpi", impact:"high",
    desc:"📊 CONSENSUS FORECAST: Core CPI +0.3% MoM. This print lands one week before the June FOMC — a hot number effectively locks in a hold, a cool number makes a July cut the base case. Year-over-year base effects become more favorable from May onward.",
    tickers:["SPY","TLT"]
  },
  {
    date:"2026-07-14", time:"08:30 ET", title:"CPI — June Data", type:"cpi", impact:"high",
    desc:"📊 CONSENSUS FORECAST: Core CPI +0.2–0.3% MoM. This is the last major data point before the July 29 FOMC. A sub-0.2% core print makes a July cut near-certain. Sets up critical bond and equity positioning into end of July.",
    tickers:["SPY","TLT"]
  },
  // Jobs
  {
    date:"2026-05-01", time:"08:30 ET", title:"Non-Farm Payrolls — April", type:"jobs", impact:"high",
    desc:"📊 CONSENSUS FORECAST: +185K jobs added (prev: +228K). Unemployment rate: 4.1%. Average hourly wages: +0.3% MoM / +3.9% YoY. A hot number (>250K, wages >+0.4%) reinforces 'higher for longer.' A miss (<100K) accelerates cut pricing. Dollar and 2-year Treasury react immediately at 08:30.",
    tickers:["SPY","DXY","TLT"]
  },
  {
    date:"2026-06-05", time:"08:30 ET", title:"Non-Farm Payrolls — May", type:"jobs", impact:"high",
    desc:"📊 CONSENSUS FORECAST: +170K jobs. Final major labor data before June FOMC. Unemployment above 4.3% would be a meaningful softening signal. Fed watching for signs labor market slack is opening up — that's the second condition (alongside cooling inflation) for rate cuts.",
    tickers:["SPY","TLT"]
  },
  // GDP
  {
    date:"2026-04-30", time:"08:30 ET", title:"Q1 2026 GDP (Advance)", type:"gdp", impact:"high",
    desc:"📊 CONSENSUS FORECAST: +1.8% annualized GDP growth (prev Q4 2025: +2.4%). Consumer spending and residential investment are key components. A negative print would be the first since 2022 and would immediately price in 2–3 rate cuts. A strong beat (>2.5%) supports equities and pushes TLT lower.",
    tickers:["SPY","TLT","DXY"]
  },
  {
    date:"2026-05-29", time:"08:30 ET", title:"Q1 2026 GDP (Second)", type:"gdp", impact:"med",
    desc:"📊 Second revision of Q1 GDP. Usually within 0.2–0.3% of the advance estimate. Market impact smaller than the advance release unless there's a large revision. Watch inventory and trade balance components.",
    tickers:["SPY"]
  },
  // Options expiry
  {
    date:"2026-05-16", title:"May OpEx — Monthly Options Expiration", type:"options", impact:"med",
    desc:"⚡ ~$2T notional in equity options expire. Max pain (the price where most options expire worthless) acts as a gravitational pull on SPY near expiry. Expect elevated intraday volatility, especially in the final hour. MM delta-hedging flows can amplify moves in either direction. VIX typically compresses post-OpEx.",
    tickers:["SPY","QQQ","VIX"]
  },
  {
    date:"2026-06-20", title:"June OpEx — Triple Witching (Quarterly)", type:"options", impact:"high",
    desc:"⚡ TRIPLE WITCHING: S&P 500 index options, equity options, AND quarterly futures all expire simultaneously. One of the highest-volume days of the year (~$5T+ notional). Rebalancing from index funds + dealer delta-hedging creates sharp moves. Monday June 23 (OpEx Monday) often sees a reversal of Friday's move.",
    tickers:["SPY","QQQ","VIX","IWM"]
  },
  // Crypto
  {
    date:"2026-05-22", title:"Bitcoin Pizza Day", type:"crypto", impact:"low",
    desc:"🍕 On May 22, 2010, Laszlo Hanyecz paid 10,000 BTC for 2 pizzas — the first real-world Bitcoin transaction. Today those coins would be worth ~$1B+. Crypto community milestone — historically no consistent price pattern but generates media coverage and community sentiment.",
    tickers:["BTC-USD"]
  },
  // Earnings (major)
  {
    date:"2026-05-07", time:"After Close", title:"NVDA Q1 FY2027 Earnings", type:"earnings", impact:"high",
    desc:"📈 WALL ST CONSENSUS: Revenue $43.3B (+65% YoY), EPS $0.89. Options market implying ±8% move. KEY QUESTIONS: (1) Blackwell GB200 NVL72 rack demand — can supply meet hyperscaler orders? (2) China revenue after export restrictions — what's the H20 run-rate? (3) Data center gross margins (target: >75%). (4) FY2027 full-year guidance. Beat + raised guidance = gap up. Miss on guidance = sharp sell regardless of EPS beat.",
    tickers:["NVDA","AMD","SMCI","TSM"]
  },
  {
    date:"2026-05-08", time:"After Close", title:"AAPL Q2 FY2026 Earnings", type:"earnings", impact:"high",
    desc:"📈 WALL ST CONSENSUS: Revenue $93.4B (+4% YoY), EPS $1.62. Options market implying ±4% move. KEY QUESTIONS: (1) Services revenue run-rate — needs >$27B to maintain 14% YoY growth. (2) iPhone 16 cycle strength — units vs. ASP. (3) China revenue vs. Huawei competition. (4) Any AI monetization signal (Apple Intelligence subscription?). Buybacks pace also closely watched.",
    tickers:["AAPL","QCOM"]
  },
  {
    date:"2026-05-14", time:"After Close", title:"MSFT Q3 FY2026 Earnings", type:"earnings", impact:"high",
    desc:"📈 WALL ST CONSENSUS: Revenue $68.5B (+12% YoY), EPS $3.21. Options market implying ±4% move. KEY QUESTIONS: (1) Azure growth rate — needs >32% constant currency for a beat; below 28% would disappoint. (2) Copilot M365 commercial seats added. (3) OpenAI partnership ROI signals. (4) Gaming segment post-Activision integration. Azure is the entire bull case — everything else is noise.",
    tickers:["MSFT","AMZN","GOOGL"]
  },
  {
    date:"2026-05-22", time:"After Close", title:"META Q1 2026 Earnings", type:"earnings", impact:"high",
    desc:"📈 WALL ST CONSENSUS: Revenue $41.5B (+16% YoY), EPS $5.25. Options market implying ±5% move. KEY QUESTIONS: (1) Ad revenue per impression — AI recommendation engine driving CPM growth? (2) DAU/MAU growth — any saturation signals? (3) 2026 capex guidance (current: $60–65B) — any increase disappoints. (4) Reality Labs quarterly loss (est. -$1.2B). (5) Threads engagement metrics.",
    tickers:["META","SNAP","PINS"]
  },
  {
    date:"2026-05-28", time:"After Close", title:"AMZN Q1 2026 Earnings", type:"earnings", impact:"high",
    desc:"📈 WALL ST CONSENSUS: Revenue $155B (+10% YoY), EPS $1.35. Options market implying ±5% move. KEY QUESTIONS: (1) AWS revenue ($28B target, needs >17% growth). (2) Advertising segment growth — now a $55B+ annual run-rate. (3) North America retail operating margin (target: >6%). (4) Capex guidance for 2026 data center buildout. AWS margins and ad revenue are the two stock-moving numbers.",
    tickers:["AMZN","MSFT","GOOGL"]
  },
  {
    date:"2026-06-05", time:"After Close", title:"GOOGL Q2 2026 Earnings", type:"earnings", impact:"high",
    desc:"📈 WALL ST CONSENSUS: Revenue $89B (+11% YoY), EPS $2.01. Options market implying ±5% move. KEY QUESTIONS: (1) Search revenue growth — market share vs. AI chatbots (ChatGPT, Claude, Perplexity). (2) Google Cloud growth rate (needs >28%). (3) YouTube ad revenue growth. (4) AI Overviews impact on search click-through. If Search growth decelerates below 8%, market will price in secular risk.",
    tickers:["GOOGL","META","MSFT"]
  },
  {
    date:"2026-06-11", time:"After Close", title:"TSLA Q2 2026 Earnings", type:"earnings", impact:"high",
    desc:"📈 WALL ST CONSENSUS: Revenue $25.5B (+8% YoY), EPS $0.45. Options market implying ±7% move. KEY QUESTIONS: (1) Q2 deliveries (consensus: 420K vehicles — missed Q1 at 387K). (2) Auto gross margins ex-credits (target: >15%). (3) Energy storage revenue ($3B+ expected). (4) FSD v13 take-rate and revenue recognition. (5) Cybertruck profitability. Delivery number (released ~July 2) often pre-trades the earnings reaction.",
    tickers:["TSLA","RIVN","NIO"]
  },
];

const TYPE_CONFIG: Record<EventType, { label: string; color: string; icon: any }> = {
  fomc:     { label: "FOMC",     color: "#ff3b3b", icon: DollarSign },
  cpi:      { label: "CPI",      color: "#f5a623", icon: TrendingUp },
  jobs:     { label: "JOBS",     color: "#4b9eff", icon: BarChart2 },
  gdp:      { label: "GDP",      color: "#a855f7", icon: Globe },
  earnings: { label: "EARNINGS", color: "#00e5a0", icon: BarChart2 },
  options:  { label: "OPEX",     color: "#ec4899", icon: Bell },
  crypto:   { label: "CRYPTO",   color: "#f5a623", icon: Cpu },
  other:    { label: "EVENT",    color: "#94a3b8", icon: Calendar },
};

const IMPACT_DOT: Record<string, string> = {
  high: "#ff3b3b", med: "#f5a623", low: "#374f68",
};

const FILTERS: EventType[] = ["fomc", "cpi", "jobs", "gdp", "earnings", "options", "crypto"];

function EventCard({ ev, expanded, onToggle }: { ev: CalEvent; expanded: boolean; onToggle: () => void }) {
  const cfg = TYPE_CONFIG[ev.type];
  const Icon = cfg.icon;
  const isPast = new Date(ev.date) < new Date(new Date().toDateString());
  const isToday = ev.date === new Date().toISOString().slice(0, 10);

  return (
    <div onClick={onToggle} style={{
      background: expanded ? "rgba(255,255,255,0.03)" : "var(--bg-card)",
      border: `1px solid ${isToday ? cfg.color + "66" : expanded ? "var(--border-light)" : "var(--border)"}`,
      borderRadius: 4, marginBottom: 6, cursor: "pointer", opacity: isPast ? 0.5 : 1,
      transition: "all 0.15s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
        {/* Impact dot */}
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: IMPACT_DOT[ev.impact], flexShrink: 0 }} />
        {/* Type badge */}
        <div style={{
          fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em",
          padding: "2px 7px", borderRadius: 3, flexShrink: 0,
          background: cfg.color + "18", color: cfg.color, border: `1px solid ${cfg.color}33`,
        }}>
          {cfg.label}
        </div>
        {/* Date + time */}
        <div style={{ flexShrink: 0, minWidth: 90 }}>
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: isToday ? cfg.color : "var(--text-secondary)", fontWeight: isToday ? 700 : 400 }}>
            {new Date(ev.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            {isToday && <span style={{ color: cfg.color, marginLeft: 5, fontSize: 9 }}>TODAY</span>}
          </span>
          {ev.time && (
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginTop: 1 }}>{ev.time}</p>
          )}
        </div>
        {/* Title */}
        <p style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{ev.title}</p>
        {/* Tickers */}
        {ev.tickers && (
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            {ev.tickers.slice(0, 3).map(t => (
              <span key={t} style={{
                fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 700,
                padding: "1px 6px", borderRadius: 3,
                background: "rgba(255,255,255,0.05)", color: "var(--text-muted)",
                border: "1px solid var(--border)",
              }}>{t}</span>
            ))}
          </div>
        )}
      </div>
      {expanded && ev.desc && (
        <div style={{ padding: "10px 14px 14px 38px", borderTop: "1px solid var(--border)" }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7 }}>{ev.desc}</p>
        </div>
      )}
    </div>
  );
}

export default function EventsPage() {
  const [filter, setFilter] = useState<EventType | "all">("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  const filtered = useMemo(() => {
    let ev = EVENTS;
    if (filter !== "all") ev = ev.filter(e => e.type === filter);
    return ev.sort((a, b) => a.date.localeCompare(b.date));
  }, [filter]);

  // Group by month
  const grouped = useMemo(() => {
    const map: Record<string, CalEvent[]> = {};
    filtered.forEach(ev => {
      const month = ev.date.slice(0, 7);
      if (!map[month]) map[month] = [];
      map[month].push(ev);
    });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const upcoming = EVENTS.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const next = upcoming[0];

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="gradient-text font-bold" style={{ fontSize: 22, marginBottom: 3 }}>Market Calendar</h1>
          <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, color: "var(--text-muted)" }}>
            FOMC · CPI · NFP · GDP · Earnings · Options Expiry
          </p>
        </div>
        {next && (
          <div style={{
            background: "var(--bg-card)", border: `1px solid ${TYPE_CONFIG[next.type].color}44`,
            borderRadius: 4, padding: "10px 16px",
          }}>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", marginBottom: 4, letterSpacing: "0.08em" }}>NEXT EVENT</p>
            <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>{next.title}</p>
            <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: TYPE_CONFIG[next.type].color }}>
              {new Date(next.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              {next.time ? ` · ${next.time}` : ""}
            </p>
          </div>
        )}
      </div>

      {/* Impact legend */}
      <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.08em" }}>IMPACT:</span>
          {[{ level: "high", label: "High" }, { level: "med", label: "Medium" }, { level: "low", label: "Low" }].map(({ level, label }) => (
            <div key={level} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: IMPACT_DOT[level] }} />
              <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: "var(--text-muted)" }}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Filter chips */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
        {(["all", ...FILTERS] as const).map(f => {
          const cfg = f === "all" ? null : TYPE_CONFIG[f];
          const active = filter === f;
          return (
            <button key={f} onClick={() => setFilter(f)} style={{
              fontFamily: "JetBrains Mono,monospace", fontSize: 10, fontWeight: 700,
              letterSpacing: "0.06em", padding: "4px 12px", borderRadius: 3, cursor: "pointer",
              textTransform: "uppercase",
              background: active ? (cfg ? cfg.color + "18" : "rgba(0,229,160,0.12)") : "var(--bg-card)",
              border: `1px solid ${active ? (cfg ? cfg.color + "44" : "rgba(0,229,160,0.3)") : "var(--border)"}`,
              color: active ? (cfg ? cfg.color : "var(--green)") : "var(--text-muted)",
            }}>
              {f === "all" ? "All Events" : TYPE_CONFIG[f].label}
            </button>
          );
        })}
      </div>

      {/* Calendar groups */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 0 }}>
        {grouped.map(([month, events]) => (
          <div key={month} style={{ marginBottom: 24 }}>
            <div style={{
              fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontWeight: 700,
              letterSpacing: "0.1em", color: "var(--text-muted)", textTransform: "uppercase",
              marginBottom: 10, paddingBottom: 6, borderBottom: "1px solid var(--border)",
            }}>
              {new Date(month + "-15").toLocaleDateString("en-US", { month: "long", year: "numeric" })}
              <span style={{ fontSize: 9, marginLeft: 8, color: "var(--text-muted)", fontWeight: 400 }}>
                {events.length} events
              </span>
            </div>
            {events.map(ev => (
              <EventCard
                key={`${ev.date}-${ev.title}`}
                ev={ev}
                expanded={expanded === `${ev.date}-${ev.title}`}
                onToggle={() => setExpanded(prev => prev === `${ev.date}-${ev.title}` ? null : `${ev.date}-${ev.title}`)}
              />
            ))}
          </div>
        ))}
      </div>

      <p style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginTop: 8 }}>
        Dates are estimates. Always verify with official sources. Not financial advice.
      </p>
    </div>
  );
}
