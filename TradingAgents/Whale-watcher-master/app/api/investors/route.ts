import { NextResponse } from "next/server";

export const revalidate = 3600; // 1 hour

const EDGAR_UA = "WhaleWatcher/1.0 contact@whalewatcher.app";

// ── SEC EDGAR 13F parser ──────────────────────────────────────────────────
async function edgarFetch(url: string) {
  const r = await fetch(url, {
    headers: { "User-Agent": EDGAR_UA },
    next: { revalidate: 3600 },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`EDGAR ${r.status} ${url}`);
  return r;
}

async function getLatest13F(cik: string) {
  const padded = cik.padStart(10, "0");
  const sub = await edgarFetch(`https://data.sec.gov/submissions/CIK${padded}.json`);
  const data = await sub.json();
  const forms: string[] = data.filings.recent.form;
  const dates: string[] = data.filings.recent.filingDate;
  const accs: string[]  = data.filings.recent.accessionNumber;
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] === "13F-HR") return { filingDate: dates[i], accession: accs[i] };
  }
  throw new Error(`No 13F-HR for CIK ${cik}`);
}

async function getInfotableUrl(cik: string, accession: string) {
  const accClean = accession.replace(/-/g, "");
  const idxUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/${accession}-index.htm`;
  const html = (await (await edgarFetch(idxUrl)).text());
  // Match infotable.xml or any numbered XML — prefer files NOT in xslForm subdirs (raw XML)
  const allMatches = [...html.matchAll(/href="([^"]*(?:infotable|[0-9]+)\.xml)"/gi)];
  if (!allMatches.length) throw new Error("infotable.xml not found");
  // Pick the match that is NOT inside an xslForm directory (raw XML data file)
  const raw = allMatches.find(m => !m[1].includes("xslForm")) ?? allMatches[0];
  let path = raw[1];
  // Strip xslForm13F_X02/ sub-directory if still present
  path = path.replace(/xslForm[^/]+\//gi, "");
  if (!path.startsWith("/")) path = `/Archives/edgar/data/${cik}/${accClean}/${path}`;
  return `https://www.sec.gov${path}`;
}

function xmlTag(body: string, tag: string): string {
  // matches <tag>, <ns:tag>, <tag attr="...">, case-insensitive
  const pat = `<(?:[a-zA-Z][a-zA-Z0-9]*:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z][a-zA-Z0-9]*:)?${tag}>`;
  return body.match(new RegExp(pat, "i"))?.[1]?.trim() ?? "";
}

function parseInfotableXml(xml: string) {
  const entries = [...xml.matchAll(/<(?:[a-zA-Z][a-zA-Z0-9]*:)?infoTable[^>]*>([\s\S]*?)<\/(?:[a-zA-Z][a-zA-Z0-9]*:)?infoTable>/gi)];
  const agg: Record<string, { value: number; shares: number; putCall: string }> = {};
  for (const [, body] of entries) {
    const name    = xmlTag(body, "nameOfIssuer");
    const val     = parseInt(xmlTag(body, "value") || "0");
    const shrs    = parseInt(xmlTag(body, "sshPrnamt") || "0");
    const putCall = xmlTag(body, "putCall");
    if (!name) continue;
    const key = putCall ? `${name}|||${putCall}` : name;
    if (!agg[key]) agg[key] = { value: 0, shares: 0, putCall };
    agg[key].value  += val;
    agg[key].shares += shrs;
  }
  return agg;
}

async function fetchEdgarInvestor(cik: string) {
  const { filingDate, accession } = await getLatest13F(cik);
  const xmlUrl = await getInfotableUrl(cik, accession);
  const xml = await (await edgarFetch(xmlUrl)).text();
  const agg = parseInfotableXml(xml);
  const totalValue = Object.values(agg).reduce((s, h) => s + h.value, 0);
  const holdings = Object.entries(agg)
    .map(([key, h]) => {
      const [rawName, pc] = key.split("|||");
      const name = rawName.trim();
      const pricePerShare = h.shares > 0 ? h.value / h.shares : 0;
      return {
        name,
        ticker: null as string | null,
        value: h.value,
        shares: h.shares,
        pricePerShare: Math.round(pricePerShare * 100) / 100,
        pctPortfolio: totalValue > 0 ? Math.round((h.value / totalValue) * 1000) / 10 : 0,
        putCall: pc ?? "",
        isOption: !!(pc && pc.length > 0),
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 25);
  return { holdings, filingDate, totalValueUsd: totalValue, source: "SEC EDGAR" };
}

// ── ARK Invest (arkfunds.io — daily updates) ─────────────────────────────
async function fetchArk() {
  const r = await fetch("https://arkfunds.io/api/v2/etf/holdings?symbol=ARKK", {
    next: { revalidate: 3600 },
    headers: { "User-Agent": "Mozilla/5.0 (compatible; WhaleWatcher/1.0)" },
  });
  if (!r.ok) throw new Error(`ARK ${r.status}`);
  const data = await r.json();
  const filingDate: string = data.date_to ?? new Date().toISOString().slice(0, 10);
  const items: any[] = data.holdings ?? [];
  const totalValue = items.reduce((s: number, h: any) => s + (h.market_value ?? 0), 0);
  const holdings = items
    .filter((h: any) => h.market_value > 500_000)
    .slice(0, 25)
    .map((h: any) => ({
      name: h.company,
      ticker: h.ticker ?? null,
      value: Math.round(h.market_value),
      shares: h.shares,
      pricePerShare: h.share_price ?? 0,
      pctPortfolio: Math.round((h.market_value / totalValue) * 1000) / 10,
      putCall: "",
      isOption: false,
    }));
  return { holdings, filingDate, totalValueUsd: totalValue, source: "arkfunds.io (daily)" };
}

// ── Config ─────────────────────────────────────────────────────────────────
const INVESTOR_META: Record<string, {
  name: string; fund: string; avatar: string; strategy: string; cik?: string; type: string;
}> = {
  berkshire: { name: "Warren Buffett",   fund: "Berkshire Hathaway",         avatar: "🏦", strategy: "Value / Buy-and-hold",      cik: "1067983",  type: "edgar" },
  burry:     { name: "Michael Burry",    fund: "Scion Asset Management",     avatar: "🐻", strategy: "Deep value / Short selling",  cik: "1649339",  type: "edgar" },
  ackman:    { name: "Bill Ackman",      fund: "Pershing Square Capital",    avatar: "♟️", strategy: "Activist / Concentrated",     cik: "1336528",  type: "edgar" },
  ark:       { name: "Cathie Wood",      fund: "ARK Invest (ARKK)",          avatar: "🚀", strategy: "Disruptive innovation / AI",  type: "ark"    },
};

// ── Route handler ─────────────────────────────────────────────────────────
export async function GET() {
  const results: Record<string, any> = {};
  await Promise.all(
    Object.entries(INVESTOR_META).map(async ([id, meta]) => {
      try {
        const data = meta.type === "ark"
          ? await fetchArk()
          : await fetchEdgarInvestor(meta.cik!);
        const totalUsd = data.totalValueUsd;
        const aum = totalUsd >= 1e9
          ? `$${(totalUsd / 1e9).toFixed(1)}B`
          : `$${(totalUsd / 1e6).toFixed(0)}M`;
        results[id] = { ...meta, id, aum, ...data };
      } catch (e) {
        results[id] = { ...meta, id, aum: "N/A", holdings: [], filingDate: "unavailable", source: "error", error: String(e) };
      }
    })
  );
  return NextResponse.json(results);
}
