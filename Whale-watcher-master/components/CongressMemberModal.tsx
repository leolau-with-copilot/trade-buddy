"use client";
import { useState, useMemo, useEffect } from "react";
import { X, ExternalLink, TrendingUp, TrendingDown, User } from "lucide-react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, LabelList,
  AreaChart, Area,
} from "recharts";
import SymbolModal from "./SymbolModal";

interface Trade {
  id: string; representative: string; party: "D"|"R"|"I"; state: string;
  chamber?: string; ticker: string; assetName: string; type: "purchase"|"sale";
  amount: string; transactionDate: string; disclosureDate: string;
  sector?: string; excessReturn?: number|null; priceChange?: number|null;
}

interface Props {
  member: string;
  trades: Trade[];
  partyColor: (p: string) => string;
  amountMidpoint: (a: string) => number;
  onClose: () => void;
}

function safeDate(s: string) {
  try { return new Date(s).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
  catch { return s; }
}
function fmtVal(n: number) {
  if (n>=1e6) return `$${(n/1e6).toFixed(1)}M`;
  if (n>=1e3) return `$${(n/1e3).toFixed(0)}K`;
  return `$${n}`;
}

// Stat block
function Stat({label,value,sub,color}:{label:string;value:string;sub?:string;color?:string}) {
  return (
    <div style={{padding:"10px 14px"}}>
      <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,letterSpacing:"0.1em",color:"#374f68",textTransform:"uppercase",marginBottom:3}}>{label}</p>
      <p style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:16,color:color??"#dce8f5"}}>{value}</p>
      {sub && <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:10,color:"#374f68",marginTop:2}}>{sub}</p>}
    </div>
  );
}

// Tooltip
function Tip({active,payload}:any) {
  if (!active||!payload?.length) return null;
  return (
    <div style={{background:"#111927",border:"1px solid #1e2d42",borderRadius:4,padding:"7px 11px",fontFamily:"JetBrains Mono,monospace",fontSize:11}}>
      <p style={{color:"#dce8f5",fontWeight:700}}>{payload[0].name}</p>
      <p style={{color:payload[0].color}}>{typeof payload[0].value==="number"?fmtVal(payload[0].value):payload[0].value}</p>
    </div>
  );
}

interface WikiBio {
  thumbnail?: string;
  description?: string;
  extract?: string;
  url?: string;
}

export default function CongressMemberModal({member,trades,partyColor,amountMidpoint,onClose}:Props) {
  const [symbolTicker, setSymbolTicker] = useState<string|null>(null);
  const [activeTab, setActiveTab] = useState<"overview"|"timeline"|"trades">("overview");
  const [bio, setBio] = useState<WikiBio|null>(null);

  const m = trades[0];
  const pColor = m ? partyColor(m.party) : "#94a3b8";

  // Fetch Wikipedia bio on mount
  useEffect(() => {
    const name = member.replace(/ /g, "_");
    fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`)
      .then(r => r.json())
      .then(d => {
        if (d.type === "standard" || d.type === "disambiguation") {
          setBio({
            thumbnail: d.thumbnail?.source,
            description: d.description,
            extract: d.extract?.slice(0, 340),
            url: d.content_urls?.desktop?.page,
          });
        }
      })
      .catch(() => {});
  }, [member]);

  const stats = useMemo(() => {
    const buys  = trades.filter(t=>t.type==="purchase");
    const sells = trades.filter(t=>t.type==="sale");
    const buyVal  = buys.reduce((s,t)=>s+amountMidpoint(t.amount),0);
    const sellVal = sells.reduce((s,t)=>s+amountMidpoint(t.amount),0);
    const totalVal = buyVal + sellVal;

    // Top tickers by frequency
    const tickerMap: Record<string,{count:number;value:number;buys:number;sells:number}> = {};
    for (const t of trades) {
      if (!t.ticker || t.ticker==="--") continue;
      if (!tickerMap[t.ticker]) tickerMap[t.ticker]={count:0,value:0,buys:0,sells:0};
      tickerMap[t.ticker].count++;
      tickerMap[t.ticker].value += amountMidpoint(t.amount);
      if (t.type==="purchase") tickerMap[t.ticker].buys++;
      else tickerMap[t.ticker].sells++;
    }
    const topTickers = Object.entries(tickerMap)
      .map(([ticker,v])=>({ticker,...v}))
      .sort((a,b)=>b.count-a.count).slice(0,10);

    // Monthly activity
    const monthMap: Record<string,{buys:number;sells:number;buyVal:number;sellVal:number}> = {};
    for (const t of trades) {
      const mo = t.transactionDate?.slice(0,7) ?? "";
      if (!mo) continue;
      if (!monthMap[mo]) monthMap[mo]={buys:0,sells:0,buyVal:0,sellVal:0};
      if (t.type==="purchase") { monthMap[mo].buys++; monthMap[mo].buyVal+=amountMidpoint(t.amount); }
      else { monthMap[mo].sells++; monthMap[mo].sellVal+=amountMidpoint(t.amount); }
    }
    const monthly = Object.entries(monthMap)
      .sort(([a],[b])=>a.localeCompare(b))
      .map(([month,v])=>({month,label:month.slice(0,7),...v}));

    // vs SPY analysis
    const withAlpha = trades.filter(t=>t.excessReturn!=null);
    const avgAlpha = withAlpha.length
      ? withAlpha.reduce((s,t)=>s+(t.excessReturn??0),0)/withAlpha.length
      : null;
    const posAlpha = withAlpha.filter(t=>(t.excessReturn??0)>0).length;
    const negAlpha = withAlpha.filter(t=>(t.excessReturn??0)<0).length;

    // Sector breakdown
    const sectorMap: Record<string,number> = {};
    for (const t of trades) {
      const sec = t.sector ?? "Unknown";
      sectorMap[sec] = (sectorMap[sec]??0) + amountMidpoint(t.amount);
    }
    const sectors = Object.entries(sectorMap)
      .map(([name,value])=>({name,value}))
      .sort((a,b)=>b.value-a.value).slice(0,8);

    return { buys, sells, buyVal, sellVal, totalVal, topTickers, monthly, avgAlpha, posAlpha, negAlpha, withAlpha, sectors };
  }, [trades, amountMidpoint]);

  const PIE_COLORS = ["#00e5a0","#ff3b3b","#4b9eff","#f5a623","#a855f7","#00d4ff","#ff8c00","#ec4899"];

  const tabs = [
    {id:"overview" as const, label:"Overview"},
    {id:"timeline" as const, label:"Timeline"},
    {id:"trades"   as const, label:`All Trades (${trades.length})`},
  ];

  return (
    <>
      {symbolTicker && (
        <SymbolModal ticker={symbolTicker} onClose={()=>setSymbolTicker(null)} />
      )}

      <div style={{position:"fixed",inset:0,zIndex:100,background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}
        onClick={onClose}>
        <div style={{background:"#0b1018",border:"1px solid #1e2d42",borderRadius:6,width:"100%",maxWidth:1000,maxHeight:"92vh",display:"flex",flexDirection:"column",overflow:"hidden"}}
          onClick={e=>e.stopPropagation()}>

          {/* ── Header ─────────────────────────────────────────────────── */}
          <div style={{borderBottom:"1px solid #162030"}}>
            {/* Name + close row */}
            <div style={{padding:"14px 18px 10px",display:"flex",alignItems:"flex-start",justifyContent:"space-between"}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:14}}>
                {/* Photo or placeholder */}
                <div style={{flexShrink:0,width:62,height:62,borderRadius:6,overflow:"hidden",
                  background:"#111927",border:"1px solid #1e2d42",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {bio?.thumbnail
                    ? <img src={bio.thumbnail} alt={member} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                    : <User size={26} style={{color:"#374f68"}}/>}
                </div>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <span style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:11,
                      padding:"2px 7px",borderRadius:3,background:pColor+"22",color:pColor,border:`1px solid ${pColor}44`}}>
                      {m?.party}
                    </span>
                    {bio?.description && (
                      <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:10,color:"#4b9eff",
                        background:"rgba(75,158,255,0.08)",border:"1px solid rgba(75,158,255,0.2)",
                        padding:"1px 7px",borderRadius:3}}>
                        {bio.description}
                      </span>
                    )}
                  </div>
                  <h2 style={{fontWeight:700,fontSize:18,color:"#dce8f5",marginBottom:3}}>{member}</h2>
                  <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:11,color:"#374f68"}}>
                    {m?.state ? `${m.state} · ` : ""}{m?.chamber ?? "Congress"} · STOCK Act disclosures
                  </p>
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                {bio?.url && (
                  <a href={bio.url} target="_blank" rel="noopener noreferrer"
                    style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,color:"#374f68",
                      textDecoration:"none",display:"flex",alignItems:"center",gap:3}}>
                    <ExternalLink size={11}/> Wikipedia
                  </a>
                )}
                <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",color:"#374f68",padding:4,display:"flex"}}>
                  <X size={18}/>
                </button>
              </div>
            </div>
            {/* Bio extract */}
            {bio?.extract && (
              <div style={{margin:"0 18px 12px",padding:"10px 14px",
                background:"rgba(75,158,255,0.04)",border:"1px solid rgba(75,158,255,0.12)",borderRadius:4}}>
                <p style={{fontSize:12,color:"#7a94b0",lineHeight:1.65,margin:0}}>{bio.extract}
                  {bio.url && <a href={bio.url} target="_blank" rel="noopener noreferrer"
                    style={{color:"#4b9eff",marginLeft:6,fontSize:11,textDecoration:"none"}}>Read more ↗</a>}
                </p>
              </div>
            )}
          </div>

          {/* ── Summary stats ────────────────────────────────────────── */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",borderBottom:"1px solid #162030"}}>
            <Stat label="TOTAL TRADES" value={String(trades.length)} sub={`${m?.state||""}`}/>
            <Stat label="BUY TRADES"   value={String(stats.buys.length)} color="#00e5a0" sub={fmtVal(stats.buyVal)}/>
            <Stat label="SELL TRADES"  value={String(stats.sells.length)} color="#ff3b3b" sub={fmtVal(stats.sellVal)}/>
            <Stat label="TOTAL VOLUME" value={fmtVal(stats.totalVal)} sub="estimated midpoint"/>
            <Stat label="AVG VS SPY"
              value={stats.avgAlpha!=null?`${stats.avgAlpha>=0?"+":""}${stats.avgAlpha.toFixed(1)}%`:"N/A"}
              color={stats.avgAlpha!=null?(stats.avgAlpha>=0?"#00e5a0":"#ff3b3b"):undefined}
              sub={stats.withAlpha.length?`from ${stats.withAlpha.length} trades`:undefined}/>
            <Stat label="WIN RATE VS SPY"
              value={stats.withAlpha.length?`${Math.round(stats.posAlpha/stats.withAlpha.length*100)}%`:"N/A"}
              color="#4b9eff"
              sub={`${stats.posAlpha}↑ ${stats.negAlpha}↓`}/>
          </div>

          {/* ── Tabs ─────────────────────────────────────────────────── */}
          <div style={{display:"flex",gap:4,padding:"8px 14px",borderBottom:"1px solid #162030"}}>
            {tabs.map(t=>(
              <button key={t.id} onClick={()=>setActiveTab(t.id)} style={{
                fontFamily:"JetBrains Mono,monospace",fontSize:10,fontWeight:700,letterSpacing:"0.06em",
                textTransform:"uppercase",padding:"4px 12px",borderRadius:3,cursor:"pointer",
                background:activeTab===t.id?"rgba(0,229,160,0.12)":"transparent",
                border:`1px solid ${activeTab===t.id?"rgba(0,229,160,0.3)":"#162030"}`,
                color:activeTab===t.id?"#00e5a0":"#374f68",
              }}>{t.label}</button>
            ))}
          </div>

          {/* ── Scrollable body ──────────────────────────────────────── */}
          <div style={{flex:1,overflowY:"auto",padding:"14px"}}>

            {/* OVERVIEW TAB */}
            {activeTab==="overview" && (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>

                {/* Buy vs Sell pie */}
                <div style={{background:"#080d16",border:"1px solid #162030",borderRadius:4,overflow:"hidden"}}>
                  <div style={{padding:"7px 12px",borderBottom:"1px solid #162030",fontFamily:"JetBrains Mono,monospace",fontSize:10,fontWeight:600,letterSpacing:"0.1em",color:"#00e5a0",background:"rgba(0,229,160,0.03)"}}>
                    BUY / SELL BREAKDOWN
                  </div>
                  <div style={{padding:"8px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                    {[
                      {label:"BUY VOLUME", val:fmtVal(stats.buyVal), color:"#00e5a0",pct:stats.totalVal?Math.round(stats.buyVal/stats.totalVal*100):0},
                      {label:"SELL VOLUME",val:fmtVal(stats.sellVal),color:"#ff3b3b",pct:stats.totalVal?Math.round(stats.sellVal/stats.totalVal*100):0},
                    ].map(s=>(
                      <div key={s.label} style={{padding:"8px 10px",background:"#0b1018",borderRadius:3,border:`1px solid ${s.color}22`}}>
                        <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,letterSpacing:"0.08em",color:"#374f68",textTransform:"uppercase"}}>{s.label}</p>
                        <p style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:16,color:s.color,marginTop:2}}>{s.val}</p>
                        <p style={{fontFamily:"JetBrains Mono,monospace",fontSize:10,color:"#374f68"}}>{s.pct}% of total</p>
                      </div>
                    ))}
                  </div>
                  <ResponsiveContainer width="100%" height={160}>
                    <PieChart>
                      <Pie data={[{name:"Buys",value:stats.buyVal},{name:"Sells",value:stats.sellVal}]}
                        dataKey="value" cx="50%" cy="50%" innerRadius={40} outerRadius={65} paddingAngle={3}>
                        <Cell fill="#00e5a0"/><Cell fill="#ff3b3b"/>
                      </Pie>
                      <Tooltip content={<Tip/>}/>
                      <Legend iconType="circle" iconSize={7}
                        formatter={(v)=><span style={{fontSize:10,fontFamily:"JetBrains Mono,monospace",color:"#7a94b0"}}>{v}</span>}/>
                    </PieChart>
                  </ResponsiveContainer>
                </div>

                {/* Top tickers */}
                <div style={{background:"#080d16",border:"1px solid #162030",borderRadius:4,overflow:"hidden"}}>
                  <div style={{padding:"7px 12px",borderBottom:"1px solid #162030",fontFamily:"JetBrains Mono,monospace",fontSize:10,fontWeight:600,letterSpacing:"0.1em",color:"#00e5a0",background:"rgba(0,229,160,0.03)"}}>
                    TOP TRADED SYMBOLS
                  </div>
                  <div style={{overflowX:"auto"}}>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={stats.topTickers} layout="vertical" margin={{left:4,right:40,top:8,bottom:4}}>
                        <CartesianGrid horizontal={false} stroke="#162030" strokeDasharray="2 4"/>
                        <XAxis type="number" tick={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#374f68"}}
                          axisLine={false} tickLine={false}/>
                        <YAxis type="category" dataKey="ticker" width={44}
                          tick={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#dce8f5",cursor:"pointer"}}
                          axisLine={false} tickLine={false}
                          onClick={(d:any)=>d?.value&&setSymbolTicker(d.value)}/>
                        <Tooltip content={<Tip/>} cursor={{fill:"rgba(255,255,255,0.02)"}}/>
                        <Bar dataKey="count" fill="#4b9eff" radius={[0,2,2,0]} name="Trades">
                          <LabelList dataKey="count" position="right"
                            style={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#374f68"}}/>
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <p style={{padding:"4px 12px 8px",fontFamily:"JetBrains Mono,monospace",fontSize:9,color:"#374f68"}}>
                    ↑ Click a ticker in the Y-axis to view its chart
                  </p>
                </div>

                {/* vs SPY distribution */}
                {stats.withAlpha.length > 0 && (
                  <div style={{background:"#080d16",border:"1px solid #162030",borderRadius:4,overflow:"hidden",gridColumn:"1/-1"}}>
                    <div style={{padding:"7px 12px",borderBottom:"1px solid #162030",fontFamily:"JetBrains Mono,monospace",fontSize:10,fontWeight:600,letterSpacing:"0.1em",color:"#00e5a0",background:"rgba(0,229,160,0.03)"}}>
                      EXCESS RETURN VS SPY — Per Trade
                      <span style={{color:"#374f68",fontWeight:400,marginLeft:8}}>
                        Formula: α = R_trade − R_SPY (same window)
                      </span>
                    </div>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart
                        data={stats.withAlpha
                          .filter(t=>t.excessReturn!=null)
                          .slice(0,30)
                          .map(t=>({name:t.ticker||t.representative.split(" ")[1],alpha:t.excessReturn,isBuy:t.type==="purchase"}))}
                        margin={{left:8,right:16,top:12,bottom:4}}>
                        <CartesianGrid strokeDasharray="2 6" stroke="#162030" vertical={false}/>
                        <XAxis dataKey="name" tick={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#374f68"}}
                          axisLine={false} tickLine={false}/>
                        <YAxis tick={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#374f68"}}
                          tickFormatter={v=>`${v>0?"+":""}${v.toFixed(0)}%`}
                          axisLine={false} tickLine={false} width={40}/>
                        <Tooltip formatter={(v:any)=>[`${(v as number)>=0?"+":""}${(v as number).toFixed(1)}%`,"vs SPY"]}
                          contentStyle={{background:"#111927",border:"1px solid #1e2d42",borderRadius:4,fontFamily:"JetBrains Mono,monospace",fontSize:11}}/>
                        <Bar dataKey="alpha" radius={[2,2,0,0]}
                          fill="#00e5a0"
                          label={false}>
                          {stats.withAlpha.filter(t=>t.excessReturn!=null).slice(0,30).map((t,i)=>(
                            <Cell key={i} fill={(t.excessReturn??0)>=0?"#00e5a0":"#ff3b3b"}/>
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            {/* TIMELINE TAB */}
            {activeTab==="timeline" && (
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{background:"#080d16",border:"1px solid #162030",borderRadius:4,overflow:"hidden"}}>
                  <div style={{padding:"7px 12px",borderBottom:"1px solid #162030",fontFamily:"JetBrains Mono,monospace",fontSize:10,fontWeight:600,letterSpacing:"0.1em",color:"#00e5a0",background:"rgba(0,229,160,0.03)"}}>
                    MONTHLY TRADING ACTIVITY — Buy vs Sell Volume
                  </div>
                  <div style={{padding:"12px 8px"}}>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={stats.monthly} margin={{left:8,right:16,top:4,bottom:4}}>
                        <CartesianGrid strokeDasharray="2 6" stroke="#162030" vertical={false}/>
                        <XAxis dataKey="label" tick={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#374f68"}} axisLine={false} tickLine={false}/>
                        <YAxis tick={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#374f68"}} tickFormatter={v=>fmtVal(v)} axisLine={false} tickLine={false} width={52}/>
                        <Tooltip contentStyle={{background:"#111927",border:"1px solid #1e2d42",borderRadius:4,fontFamily:"JetBrains Mono,monospace",fontSize:11}} formatter={(v:any)=>fmtVal(v as number)}/>
                        <Bar dataKey="buyVal"  name="Buy Volume"  fill="#00e5a0" radius={[2,2,0,0]}/>
                        <Bar dataKey="sellVal" name="Sell Volume" fill="#ff3b3b" radius={[2,2,0,0]}/>
                        <Legend iconType="circle" iconSize={7}
                          formatter={(v)=><span style={{fontSize:10,fontFamily:"JetBrains Mono,monospace",color:"#7a94b0"}}>{v}</span>}/>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div style={{background:"#080d16",border:"1px solid #162030",borderRadius:4,overflow:"hidden"}}>
                  <div style={{padding:"7px 12px",borderBottom:"1px solid #162030",fontFamily:"JetBrains Mono,monospace",fontSize:10,fontWeight:600,letterSpacing:"0.1em",color:"#00e5a0",background:"rgba(0,229,160,0.03)"}}>
                    TRADE COUNT PER MONTH
                  </div>
                  <div style={{padding:"12px 8px"}}>
                    <ResponsiveContainer width="100%" height={140}>
                      <AreaChart data={stats.monthly} margin={{left:8,right:16,top:4,bottom:4}}>
                        <defs>
                          <linearGradient id="bGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#4b9eff" stopOpacity={0.2}/><stop offset="95%" stopColor="#4b9eff" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="2 6" stroke="#162030" vertical={false}/>
                        <XAxis dataKey="label" tick={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#374f68"}} axisLine={false} tickLine={false}/>
                        <YAxis tick={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fill:"#374f68"}} axisLine={false} tickLine={false} width={24}/>
                        <Tooltip contentStyle={{background:"#111927",border:"1px solid #1e2d42",borderRadius:4,fontFamily:"JetBrains Mono,monospace",fontSize:11}}/>
                        <Area dataKey="buys" name="Buys" stroke="#00e5a0" fill="none" strokeWidth={1.5} dot={false}/>
                        <Area dataKey="sells" name="Sells" stroke="#ff3b3b" fill="none" strokeWidth={1.5} dot={false}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}

            {/* ALL TRADES TAB */}
            {activeTab==="trades" && (
              <div style={{background:"#080d16",border:"1px solid #162030",borderRadius:4,overflow:"hidden"}}>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr style={{borderBottom:"1px solid #162030",background:"#080d16"}}>
                        {["Ticker","Type","Amount","Traded","Disclosed","vs SPY"].map((h,i)=>(
                          <th key={h} style={{fontFamily:"JetBrains Mono,monospace",fontSize:9,fontWeight:600,letterSpacing:"0.1em",textTransform:"uppercase",color:"#374f68",padding:"8px 12px",textAlign:i>=2?"right":"left"}}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map(t=>{
                        const isBuy=t.type==="purchase";
                        return (
                          <tr key={t.id} style={{borderBottom:"1px solid #162030"}}
                            onMouseEnter={e=>e.currentTarget.style.background="#0f1520"}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <td style={{padding:"7px 12px"}}>
                              {t.ticker&&t.ticker!=="--" ? (
                                <button onClick={()=>setSymbolTicker(t.ticker)}
                                  style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,fontSize:12,color:"#4b9eff",background:"none",border:"none",cursor:"pointer",padding:0,textDecoration:"none"}}
                                  title="Click to view chart">
                                  {t.ticker}
                                </button>
                              ):<span style={{color:"#374f68"}}>—</span>}
                              <p style={{fontSize:10,color:"#374f68",marginTop:1,maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.assetName}</p>
                            </td>
                            <td style={{padding:"7px 12px"}}>
                              <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:3,
                                background:isBuy?"rgba(0,229,160,0.12)":"rgba(255,59,59,0.12)",
                                border:`1px solid ${isBuy?"rgba(0,229,160,0.2)":"rgba(255,59,59,0.2)"}`,
                                color:isBuy?"#00e5a0":"#ff3b3b"}}>
                                {isBuy?"BUY":"SELL"}
                              </span>
                            </td>
                            <td style={{padding:"7px 12px",textAlign:"right",fontFamily:"JetBrains Mono,monospace",fontSize:11,color:"#7a94b0"}}>{t.amount}</td>
                            <td style={{padding:"7px 12px",textAlign:"right",fontFamily:"JetBrains Mono,monospace",fontSize:11,color:"#7a94b0"}}>{safeDate(t.transactionDate)}</td>
                            <td style={{padding:"7px 12px",textAlign:"right",fontFamily:"JetBrains Mono,monospace",fontSize:11,color:"#374f68"}}>{safeDate(t.disclosureDate)}</td>
                            <td style={{padding:"7px 12px",textAlign:"right"}}>
                              {t.excessReturn!=null?(
                                <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:11,fontWeight:700,color:t.excessReturn>=0?"#00e5a0":"#ff3b3b"}}>
                                  {t.excessReturn>=0?"+":""}{t.excessReturn.toFixed(1)}%
                                </span>
                              ):<span style={{color:"#374f68"}}>—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{padding:"8px 16px",borderTop:"1px solid #162030",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:10,color:"#374f68"}}>
              Source: Quiver Quant · STOCK Act disclosures · Click any ticker to view chart
            </span>
            <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:10,color:"#374f68"}}>ESC to close</span>
          </div>
        </div>
      </div>
    </>
  );
}
