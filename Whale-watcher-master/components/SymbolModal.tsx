"use client";
import { useState, useEffect, useCallback } from "react";
import { X, ExternalLink, RefreshCw, Activity } from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

interface Quote { price: number; change: number; changePct: number }
interface OHLCPoint { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Props { ticker: string; name?: string; onClose: () => void }

interface NewsItem { title: string; link: string; pubDate: string; source: string }

interface EarningsQuarter {
  quarter: string;
  date: string;
  epsEst: number | null;
  epsActual: number | null;
  surprise: number | null;
}

interface EarningsData {
  history: EarningsQuarter[];
  nextEarnings: { date: string | null; epsEst: number | null; revenueEst: number | null } | null;
  peRatio: number | null;
  pegRatio: number | null;
}

function tvSymbol(ticker: string): string {
  const map: Record<string, string> = {
    "BTC-USD":"BITSTAMP:BTCUSD","ETH-USD":"KRAKEN:ETHUSD",
    "BTC":"BITSTAMP:BTCUSD","ETH":"KRAKEN:ETHUSD",
    "SOL-USD":"KRAKEN:SOLUSD","SOL":"KRAKEN:SOLUSD",
  };
  return map[ticker] ?? ticker;
}

const RANGES = ["1D","5D","1M","3M","6M","1Y","5Y"] as const;
type Range = typeof RANGES[number];

const YF_RANGE: Record<Range,string> = {
  "1D":"1d","5D":"5d","1M":"1mo","3M":"3mo","6M":"6mo","1Y":"1y","5Y":"5y",
};

function fmtVol(n: number) {
  if (n >= 1e9) return `${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n/1e3).toFixed(0)}K`;
  return String(n);
}
function fmtDate(d: string) {
  try { return new Date(d).toLocaleDateString("en-US",{month:"short",day:"numeric"}); }
  catch { return d; }
}

function timeAgo(pubDate: string): string {
  try {
    const diff = Date.now() - new Date(pubDate).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return pubDate;
  }
}

function ChartTip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as OHLCPoint;
  return (
    <div style={{background:"#111927",border:"1px solid #1e2d42",borderRadius:4,padding:"8px 12px",fontFamily:"JetBrains Mono,monospace",fontSize:11}}>
      <p style={{color:"#7a94b0",marginBottom:4}}>{fmtDate(d.date)}</p>
      <p style={{color:"#dce8f5",fontWeight:700}}>${d.close?.toFixed(2)}</p>
      {d.open != null && <div style={{color:"#4b9eff",marginTop:2}}>O:{d.open?.toFixed(2)} H:{d.high?.toFixed(2)} L:{d.low?.toFixed(2)}</div>}
      {d.volume > 0 && <p style={{color:"#374f68",marginTop:2}}>Vol {fmtVol(d.volume)}</p>}
    </div>
  );
}

export default function SymbolModal({ ticker, name, onClose }: Props) {
  const [range, setRange] = useState<Range>("3M");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [history, setHistory] = useState<OHLCPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [high52w, setHigh52w] = useState<number | null>(null);
  const [low52w,  setLow52w]  = useState<number | null>(null);
  const [volume,  setVolume]  = useState<number | null>(null);
  const [chartView, setChartView] = useState<"tv"|"chart">("tv");

  // Main tab state
  const [tab, setTab] = useState<"chart" | "news" | "earnings">("chart");

  // News state
  const [news, setNews] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsFetched, setNewsFetched] = useState(false);

  // Earnings state
  const [earnings, setEarnings] = useState<EarningsData | null>(null);
  const [earningsLoading, setEarningsLoading] = useState(false);
  const [earningsFetched, setEarningsFetched] = useState(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/chart/${encodeURIComponent(ticker)}?range=${YF_RANGE[range]}`);
      const d = await res.json();
      if (d.data?.length) setHistory(d.data);
      if (d.meta?.high52w) setHigh52w(d.meta.high52w);
      if (d.meta?.low52w)  setLow52w(d.meta.low52w);
      if (d.meta?.volume)  setVolume(d.meta.volume);
    } catch {}
    setLoading(false);
  }, [ticker, range]);

  const fetchQuote = useCallback(() => {
    fetch(`/api/stocks?tickers=${ticker}`).then(r=>r.json())
      .then(d => { const q = d.quotes?.[ticker]; if (q) { setQuote(q); setLastUpdate(new Date()); }})
      .catch(()=>{});
  }, [ticker]);

  const fetchNews = useCallback(async () => {
    if (newsFetched) return;
    setNewsLoading(true);
    try {
      const res = await fetch(`/api/news?ticker=${encodeURIComponent(ticker)}`);
      const d = await res.json();
      setNews(d.items ?? []);
    } catch {}
    setNewsLoading(false);
    setNewsFetched(true);
  }, [ticker, newsFetched]);

  const fetchEarnings = useCallback(async () => {
    if (earningsFetched) return;
    setEarningsLoading(true);
    try {
      const res = await fetch(`/api/earnings?ticker=${encodeURIComponent(ticker)}`);
      const d = await res.json();
      setEarnings(d);
    } catch {}
    setEarningsLoading(false);
    setEarningsFetched(true);
  }, [ticker, earningsFetched]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);
  useEffect(() => {
    fetchQuote();
    const iv = setInterval(fetchQuote, 1000);
    return () => clearInterval(iv);
  }, [fetchQuote]);

  useEffect(() => {
    if (tab === "news") fetchNews();
    if (tab === "earnings") fetchEarnings();
  }, [tab, fetchNews, fetchEarnings]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const pos = (quote?.changePct ?? 0) >= 0;
  const lineColor = pos ? "#00e5a0" : "#ff3b3b";
  const openPrice = history[0]?.close ?? null;
  const tvSym = tvSymbol(ticker);
  const tvUrl = `https://www.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSym)}&interval=D&theme=dark&style=1&locale=en&toolbar_bg=%230b1018&withdateranges=1&range=${range}&hide_side_toolbar=0&allow_symbol_change=0&calendar=0&save_image=0&details=1&hotlist=0&news=0&studies=%5B%5D`;

  const TAB_STYLE = (active: boolean) => ({
    fontFamily: "JetBrains Mono,monospace",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    padding: "5px 14px",
    borderRadius: 3,
    cursor: "pointer",
    background: active ? "rgba(0,229,160,0.1)" : "transparent",
    border: "none",
    borderBottom: active ? "2px solid #00e5a0" : "2px solid transparent",
    color: active ? "#00e5a0" : "#374f68",
  });

  return (
    <div style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.88)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}
      onClick={onClose}>
      <div style={{background:"#0b1018",border:"1px solid #1e2d42",borderRadius:6,width:"100%",maxWidth:980,maxHeight:"92vh",display:"flex",flexDirection:"column",overflow:"hidden"}}
        onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #162030",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:20,color:"#dce8f5"}}>{ticker}</span>
            {name && <span style={{color:"#7a94b0",fontSize:12}}>{name}</span>}
            {quote ? (
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:20,color:"#dce8f5"}}>${quote.price.toFixed(2)}</span>
                <span style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:14,color:lineColor}}>
                  {pos?"▲ +":"▼ "}{quote.changePct.toFixed(2)}%
                </span>
                <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:12,color:"#374f68"}}>
                  {quote.change>=0?"+":""}${quote.change.toFixed(2)} today
                </span>
              </div>
            ) : <RefreshCw size={14} className="animate-spin" style={{color:"#00e5a0"}} />}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {lastUpdate && (
              <div style={{display:"flex",alignItems:"center",gap:4,fontFamily:"JetBrains Mono,monospace",fontSize:10,color:"#374f68"}}>
                <Activity size={9} style={{color:"#00e5a0"}} />
                {lastUpdate.toLocaleTimeString()} · 1s live
              </div>
            )}
            <a href={`https://finance.yahoo.com/quote/${ticker}`} target="_blank" rel="noopener noreferrer"
              style={{color:"#374f68",display:"flex",padding:4}} title="Yahoo Finance">
              <ExternalLink size={13}/>
            </a>
            <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",color:"#374f68",padding:4,display:"flex"}}>
              <X size={17}/>
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",borderBottom:"1px solid #162030"}}>
          {[
            {label:"52W HIGH", value:high52w?`$${high52w.toFixed(2)}`:"—", color:"#00e5a0"},
            {label:"52W LOW",  value:low52w?`$${low52w.toFixed(2)}`:"—",   color:"#ff3b3b"},
            {label:"VOLUME",   value:volume?fmtVol(volume):"—",             color:"#dce8f5"},
            {label:"PREV CLOSE",value:openPrice?`$${openPrice.toFixed(2)}`:"—", color:"#4b9eff"},
          ].map(s=>(
            <div key={s.label} style={{padding:"8px 16px",borderRight:"1px solid #162030"}}>
              <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,letterSpacing:"0.1em",color:"#374f68",textTransform:"uppercase",marginBottom:3}}>{s.label}</p>
              <p style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:15,color:s.color}}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Main tabs: CHART / NEWS / EARNINGS */}
        <div style={{display:"flex",alignItems:"center",padding:"0 12px",borderBottom:"1px solid #162030",gap:2}}>
          <button style={TAB_STYLE(tab === "chart")} onClick={() => setTab("chart")}>Chart</button>
          <button style={TAB_STYLE(tab === "news")} onClick={() => setTab("news")}>News</button>
          <button style={TAB_STYLE(tab === "earnings")} onClick={() => setTab("earnings")}>Earnings</button>
        </div>

        {/* Chart tab content */}
        {tab === "chart" && (
          <>
            {/* Sub-tab + range bar */}
            <div style={{display:"flex",gap:4,padding:"8px 12px",borderBottom:"1px solid #162030",alignItems:"center"}}>
              {(["tv","chart"] as const).map(t=>(
                <button key={t} onClick={()=>setChartView(t)} style={{
                  fontFamily:"JetBrains Mono,monospace",fontSize:10,fontWeight:700,letterSpacing:"0.06em",
                  textTransform:"uppercase",padding:"4px 10px",borderRadius:3,cursor:"pointer",
                  background:chartView===t?"rgba(0,229,160,0.12)":"transparent",
                  border:`1px solid ${chartView===t?"rgba(0,229,160,0.3)":"#162030"}`,
                  color:chartView===t?"#00e5a0":"#374f68",
                }}>{t==="tv"?"TradingView":"Price History"}</button>
              ))}
              <div style={{flex:1}}/>
              {RANGES.map(r=>(
                <button key={r} onClick={()=>setRange(r)} style={{
                  fontFamily:"JetBrains Mono,monospace",fontSize:10,fontWeight:600,padding:"3px 8px",borderRadius:3,cursor:"pointer",
                  background:range===r?"rgba(75,158,255,0.12)":"transparent",
                  border:`1px solid ${range===r?"rgba(75,158,255,0.3)":"transparent"}`,
                  color:range===r?"#4b9eff":"#374f68",
                }}>{r}</button>
              ))}
            </div>

            <div style={{flex:1,minHeight:400,position:"relative"}}>
              {chartView==="tv" ? (
                <iframe key={`${tvSym}-${range}`} src={tvUrl} width="100%" height="100%"
                  style={{border:"none",minHeight:400,display:"block"}} allowTransparency={true}/>
              ) : (
                <div style={{padding:"12px 8px 4px",height:"100%",minHeight:400}}>
                  {loading ? (
                    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",gap:10,color:"#374f68"}}>
                      <RefreshCw size={18} className="animate-spin" style={{color:"#00e5a0"}}/>
                      <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:12}}>Loading…</span>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={history} margin={{left:0,right:16,top:8,bottom:0}}>
                        <defs>
                          <linearGradient id="pGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor={lineColor} stopOpacity={0.2}/>
                            <stop offset="95%" stopColor={lineColor} stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="2 6" stroke="#162030" vertical={false}/>
                        <XAxis dataKey="date" tickFormatter={fmtDate}
                          tick={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#374f68"}}
                          axisLine={false} tickLine={false} interval="preserveStartEnd"/>
                        <YAxis domain={["auto","auto"]}
                          tick={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#374f68"}}
                          tickFormatter={v=>`$${v.toFixed(0)}`}
                          axisLine={false} tickLine={false} width={56}/>
                        <Tooltip content={<ChartTip/>}/>
                        {openPrice && <ReferenceLine y={openPrice} stroke="#374f68" strokeDasharray="3 4"/>}
                        <Area dataKey="close" stroke={lineColor} strokeWidth={1.5}
                          fill="url(#pGrad)" dot={false} activeDot={{r:3,fill:lineColor}}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* News tab content */}
        {tab === "news" && (
          <div style={{flex:1,overflowY:"auto",padding:16,minHeight:400}}>
            {newsLoading ? (
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:200,gap:10,color:"#374f68"}}>
                <RefreshCw size={18} className="animate-spin" style={{color:"#00e5a0"}}/>
                <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:12}}>Loading news…</span>
              </div>
            ) : news.length === 0 ? (
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:200}}>
                <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:12,color:"#374f68"}}>No recent news</span>
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {news.map((item, i) => (
                  <a
                    key={i}
                    href={item.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display:"block",
                      background:"#0e1822",
                      border:"1px solid #1e2d42",
                      borderRadius:4,
                      padding:"10px 14px",
                      textDecoration:"none",
                      transition:"border-color 0.15s",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = "#2a3f58")}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = "#1e2d42")}
                  >
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <span style={{
                        fontFamily:"JetBrains Mono,monospace",
                        fontSize:9,
                        letterSpacing:"0.08em",
                        textTransform:"uppercase",
                        color:"#00e5a0",
                        fontWeight:700,
                      }}>{item.source}</span>
                      <span style={{
                        fontFamily:"JetBrains Mono,monospace",
                        fontSize:9,
                        color:"#374f68",
                      }}>{item.pubDate ? timeAgo(item.pubDate) : ""}</span>
                    </div>
                    <p style={{
                      fontFamily:"JetBrains Mono,monospace",
                      fontSize:12,
                      color:"#dce8f5",
                      margin:0,
                      lineHeight:1.5,
                    }}>{item.title}</p>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Earnings tab content */}
        {tab === "earnings" && (
          <div style={{flex:1,overflowY:"auto",padding:16,minHeight:400}}>
            {earningsLoading ? (
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:200,gap:10,color:"#374f68"}}>
                <RefreshCw size={18} className="animate-spin" style={{color:"#00e5a0"}}/>
                <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:12}}>Loading earnings…</span>
              </div>
            ) : !earnings || (earnings.history.length === 0 && !earnings.nextEarnings) ? (
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:200}}>
                <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:12,color:"#374f68"}}>Earnings data unavailable</span>
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:16}}>

                {/* Next Earnings card */}
                {earnings.nextEarnings && (
                  <div style={{background:"#0e1822",border:"1px solid #1e2d42",borderRadius:4,padding:"12px 16px"}}>
                    <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,letterSpacing:"0.1em",textTransform:"uppercase",color:"#374f68",marginBottom:10}}>Next Earnings</p>
                    <div style={{display:"flex",flexWrap:"wrap",gap:20,alignItems:"center"}}>
                      {earnings.nextEarnings.date && (
                        <div>
                          <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,color:"#374f68",marginBottom:2}}>DATE</p>
                          <p style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:16,color:"#dce8f5"}}>{earnings.nextEarnings.date}</p>
                        </div>
                      )}
                      {earnings.nextEarnings.epsEst !== null && (
                        <div>
                          <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,color:"#374f68",marginBottom:2}}>EPS EST</p>
                          <p style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:16,color:"#00e5a0"}}>${earnings.nextEarnings.epsEst.toFixed(2)}</p>
                        </div>
                      )}
                      {earnings.nextEarnings.revenueEst !== null && (
                        <div>
                          <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,color:"#374f68",marginBottom:2}}>REV EST</p>
                          <p style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:16,color:"#4b9eff"}}>${(earnings.nextEarnings.revenueEst / 1e9).toFixed(2)}B</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* PE / PEG pills */}
                {(earnings.peRatio !== null || earnings.pegRatio !== null) && (
                  <div style={{display:"flex",gap:10}}>
                    {earnings.peRatio !== null && (
                      <div style={{background:"#0e1822",border:"1px solid #1e2d42",borderRadius:4,padding:"8px 14px"}}>
                        <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,color:"#374f68",marginBottom:2}}>FORWARD P/E</p>
                        <p style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:15,color:"#dce8f5"}}>{earnings.peRatio.toFixed(2)}x</p>
                      </div>
                    )}
                    {earnings.pegRatio !== null && (
                      <div style={{background:"#0e1822",border:"1px solid #1e2d42",borderRadius:4,padding:"8px 14px"}}>
                        <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,color:"#374f68",marginBottom:2}}>PEG RATIO</p>
                        <p style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:15,color:"#dce8f5"}}>{earnings.pegRatio.toFixed(2)}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Earnings history table */}
                {earnings.history.length > 0 && (
                  <div style={{background:"#0e1822",border:"1px solid #1e2d42",borderRadius:4,overflow:"hidden"}}>
                    <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,letterSpacing:"0.1em",textTransform:"uppercase",color:"#374f68",padding:"10px 14px 6px"}}>Past Quarters</p>
                    <table style={{width:"100%",borderCollapse:"collapse"}}>
                      <thead>
                        <tr style={{borderBottom:"1px solid #162030"}}>
                          {["Quarter","Date","Est EPS","Actual EPS","Surprise"].map(h => (
                            <th key={h} style={{
                              fontFamily:"JetBrains Mono,monospace",fontSize:9,letterSpacing:"0.08em",
                              textTransform:"uppercase",color:"#374f68",textAlign:"left",
                              padding:"6px 14px",fontWeight:600,
                            }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {earnings.history.slice(0, 4).map((q, i) => {
                          const surpriseColor = q.surprise === null ? "#7a94b0" : q.surprise >= 0 ? "#00e5a0" : "#ff3b3b";
                          const surpriseLabel = q.surprise === null ? "—"
                            : q.surprise >= 0 ? `+${q.surprise.toFixed(1)}%` : `${q.surprise.toFixed(1)}%`;
                          return (
                            <tr key={i} style={{borderBottom:"1px solid #162030"}}>
                              <td style={{fontFamily:"JetBrains Mono,monospace",fontSize:11,color:"#dce8f5",padding:"8px 14px",fontWeight:700}}>{q.quarter || "—"}</td>
                              <td style={{fontFamily:"JetBrains Mono,monospace",fontSize:11,color:"#7a94b0",padding:"8px 14px"}}>{q.date || "—"}</td>
                              <td style={{fontFamily:"JetBrains Mono,monospace",fontSize:11,color:"#7a94b0",padding:"8px 14px"}}>{q.epsEst !== null ? `$${q.epsEst.toFixed(2)}` : "—"}</td>
                              <td style={{fontFamily:"JetBrains Mono,monospace",fontSize:11,color:"#dce8f5",padding:"8px 14px",fontWeight:600}}>{q.epsActual !== null ? `$${q.epsActual.toFixed(2)}` : "—"}</td>
                              <td style={{fontFamily:"JetBrains Mono,monospace",fontSize:11,color:surpriseColor,padding:"8px 14px",fontWeight:700}}>{surpriseLabel}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{padding:"7px 16px",borderTop:"1px solid #162030",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:10,color:"#374f68"}}>
            TradingView chart · Yahoo Finance prices · ESC to close
          </span>
          <a href={`https://finance.yahoo.com/quote/${ticker}`} target="_blank" rel="noopener noreferrer"
            style={{fontFamily:"JetBrains Mono,monospace",fontSize:10,color:"#4b9eff",textDecoration:"none"}}>
            Full Yahoo Finance ↗
          </a>
        </div>
      </div>
    </div>
  );
}
