import { NextResponse } from "next/server";

export const revalidate = 300;

const EDGAR_UA = "WhaleWatcher/1.0 (yoann.russev@gmail.com)";

interface InsiderTrade {
  filingDate: string;
  tradeDate: string;
  ticker: string;
  company: string;
  insiderName: string;
  title: string;
  tradeType: string;
  price: number;
  qty: number;
  owned: number;
  value: number;
}

// Target companies for SELLS — mega-caps where insider selling is frequent
const SELL_TARGETS = [
  { cik: "320193",  ticker: "AAPL", company: "Apple Inc" },
  { cik: "789019",  ticker: "MSFT", company: "Microsoft Corp" },
  { cik: "1045810", ticker: "NVDA", company: "NVIDIA Corp" },
  { cik: "1318605", ticker: "TSLA", company: "Tesla Inc" },
  { cik: "1326801", ticker: "META", company: "Meta Platforms" },
  { cik: "1018724", ticker: "AMZN", company: "Amazon.com Inc" },
  { cik: "1652044", ticker: "GOOGL", company: "Alphabet Inc" },
  { cik: "2488",    ticker: "AMD",  company: "Advanced Micro Devices" },
  { cik: "19617",   ticker: "JPM",  company: "JPMorgan Chase" },
  { cik: "886982",  ticker: "GS",   company: "Goldman Sachs" },
  { cik: "1321655", ticker: "PLTR", company: "Palantir Technologies" },
  { cik: "1679788", ticker: "COIN", company: "Coinbase Global" },
  { cik: "1403161", ticker: "V",    company: "Visa Inc" },
  { cik: "764038",  ticker: "PANW", company: "Palo Alto Networks" },
  { cik: "1108524", ticker: "CRM",  company: "Salesforce Inc" },
];

// Parse Form 4 XML → extract non-derivative transactions (buys/sells)
function parseForm4(xml: string): { code: string; qty: number; price: number; owned: number; title: string }[] {
  const results: { code: string; qty: number; price: number; owned: number; title: string }[] = [];
  const titleM = xml.match(/<officerTitle>(.*?)<\/officerTitle>/);
  const title = titleM?.[1]?.trim() ?? "Director";
  const txBlocks = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)];
  for (const tx of txBlocks) {
    const c = tx[1];
    const code = c.match(/<transactionCode>(.*?)<\/transactionCode>/)?.[1]?.trim() ?? "";
    if (code !== "P" && code !== "S") continue;
    const qty   = parseInt(c.match(/<transactionShares>\s*<value>([\d.]+)<\/value>/)?.[1] ?? "0", 10);
    const price = parseFloat(c.match(/<transactionPricePerShare>\s*<value>([\d.]+)<\/value>/)?.[1] ?? "0");
    const owned = parseInt(c.match(/<sharesOwnedFollowingTransaction>\s*<value>([\d.]+)<\/value>/)?.[1] ?? "0", 10);
    if (qty > 0 && price > 0) results.push({ code, qty, price, owned, title });
  }
  return results;
}

// Fetch Form 4 XML from a known index.htm URL
async function fetchXMLFromIndex(indexUrl: string, adsh: string): Promise<string | null> {
  const accNoDash = adsh.replace(/-/g, "");
  try {
    const ir = await fetch(indexUrl, {
      headers: { "User-Agent": EDGAR_UA },
      signal: AbortSignal.timeout(3000),
    });
    if (!ir.ok) return null;
    const html = await ir.text();
    const xmlMatch = html.match(/href="([^"]*\.xml)"/i);
    if (!xmlMatch) return null;
    const filename = xmlMatch[1].split("/").pop()!;
    const hrefCikMatch = xmlMatch[1].match(/\/data\/(\d+)\//);
    const dataCik = hrefCikMatch?.[1];
    if (!dataCik) return null;
    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${dataCik}/${accNoDash}/${filename}`;
    const xr = await fetch(xmlUrl, {
      headers: { "User-Agent": EDGAR_UA },
      signal: AbortSignal.timeout(3000),
    });
    if (!xr.ok) return null;
    return await xr.text();
  } catch {
    return null;
  }
}

// ── BUYS: EFTS full-text search for "Open-Market Purchase" phrase ─────────────
// EDGAR full-text search finds Form 4 filings that contain the literal phrase
// "Open-Market Purchase" — this phrase only appears when transaction code = "P".
// 60-day window typically yields 20-30 real insider purchases across any company.
async function fetchBroadBuys(): Promise<InsiderTrade[]> {
  const start = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const end   = new Date().toISOString().slice(0, 10);

  const eftsUrl = `https://efts.sec.gov/LATEST/search-index?q=%22Open-Market+Purchase%22&forms=4&dateRange=custom&startdt=${start}&enddt=${end}`;
  const res = await fetch(eftsUrl, {
    headers: { "User-Agent": EDGAR_UA, "Accept": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = await res.json() as any;
  const hits: Array<{ _source: { adsh: string; file_date: string } }> = json?.hits?.hits ?? [];
  if (!hits.length) return [];

  // Fetch XMLs in parallel — cap at 10 to stay within Vercel timeout
  const results = await Promise.all(
    hits.slice(0, 10).map(async ({ _source: src }) => {
      const adsh     = src.adsh;
      const fileDate = src.file_date ?? "";

      // Construct index URL: filer CIK is the numeric prefix of the accession number
      const filerCik = parseInt(adsh.split("-")[0], 10).toString();
      const indexUrl = `https://www.sec.gov/Archives/edgar/data/${filerCik}/${adsh.replace(/-/g, "")}/${adsh}-index.htm`;

      const xml = await fetchXMLFromIndex(indexUrl, adsh);
      if (!xml) return [] as InsiderTrade[];

      const txs = parseForm4(xml);
      const purchases = txs.filter(t => t.code === "P");
      if (!purchases.length) return [] as InsiderTrade[];

      const ticker      = xml.match(/<issuerTradingSymbol>(.*?)<\/issuerTradingSymbol>/)?.[1]?.trim() ?? "";
      if (!ticker || ticker.length > 5 || /[^A-Z.]/.test(ticker)) return [] as InsiderTrade[];

      const company     = xml.match(/<issuerName>(.*?)<\/issuerName>/)?.[1]?.trim() ?? ticker;
      const insiderName = xml.match(/<rptOwnerName>(.*?)<\/rptOwnerName>/)?.[1]?.trim() ?? "Unknown";

      return purchases.map((t): InsiderTrade => ({
        filingDate: fileDate,
        tradeDate:  fileDate,
        ticker,
        company,
        insiderName,
        title: t.title,
        tradeType: "P - Purchase",
        price: t.price,
        qty:   t.qty,
        owned: t.owned,
        value: t.qty * t.price,
      }));
    })
  );

  return results.flat().filter(t => t.value >= 5000).sort((a, b) => b.value - a.value).slice(0, 25);
}

// ── SELLS: Targeted search across 15 major companies ─────────────────────────
async function fetchTargetedSells(): Promise<InsiderTrade[]> {
  const cutoffDate = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

  const batches = await Promise.all(
    SELL_TARGETS.map(async ({ cik, ticker, company }) => {
      try {
        const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=5&search_text=&output=atom`;
        const res = await fetch(url, {
          headers: { "User-Agent": EDGAR_UA },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return [] as InsiderTrade[];
        const atomXml = await res.text();

        const adshMatches = [...atomXml.matchAll(/<accession-number>([\d-]+)<\/accession-number>/g)];
        const dateMatches  = [...atomXml.matchAll(/<filing-date>([\d-]+)<\/filing-date>/g)];
        const trades: InsiderTrade[] = [];

        for (let i = 0; i < Math.min(adshMatches.length, 3); i++) {
          const adsh     = adshMatches[i][1];
          const fileDate = dateMatches[i]?.[1] ?? "";
          if (fileDate && fileDate < cutoffDate) continue;

          const reporterCik = adsh.split("-")[0];
          const cikNum = parseInt(reporterCik, 10).toString();
          const accNoDash = adsh.replace(/-/g, "");
          const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${adsh}-index.htm`;

          const xml = await fetchXMLFromIndex(indexUrl, adsh);
          if (!xml) continue;

          const insiderName = xml.match(/<rptOwnerName>(.*?)<\/rptOwnerName>/)?.[1]?.trim() ?? "Unknown";
          const txs = parseForm4(xml);

          for (const t of txs.filter(t => t.code === "S")) {
            trades.push({
              filingDate: fileDate || new Date().toISOString().slice(0, 10),
              tradeDate:  fileDate || new Date().toISOString().slice(0, 10),
              ticker, company, insiderName,
              title: t.title,
              tradeType: "S - Sale",
              price: t.price, qty: t.qty, owned: t.owned,
              value: t.qty * t.price,
            });
          }
        }
        return trades;
      } catch {
        return [] as InsiderTrade[];
      }
    })
  );

  return batches.flat()
    .filter(t => t.value >= 10000)
    .sort((a, b) => b.value - a.value)
    .slice(0, 25);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") === "sells" ? "sells" : "buys";

  try {
    const trades = type === "buys"
      ? await fetchBroadBuys()
      : await fetchTargetedSells();
    if (trades.length > 0) return NextResponse.json({ trades, source: "edgar" });
  } catch { /* fall through */ }

  // Fallback — no named fake people, just a clear indicator
  return NextResponse.json({ trades: [], source: "no_data" });
}
