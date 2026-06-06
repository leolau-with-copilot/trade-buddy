import { NextResponse } from "next/server";

const EDGAR_UA = "WhaleWatcher/1.0 contact@whalewatcher.app";

async function edgarFetch(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": EDGAR_UA }, cache: "no-store" });
  if (!r.ok) throw new Error(`EDGAR ${r.status} ${url}`);
  return r;
}

export async function GET() {
  try {
    // Berkshire CIK 1067983
    const cik = "1067983";
    const padded = cik.padStart(10, "0");
    const sub = await edgarFetch(`https://data.sec.gov/submissions/CIK${padded}.json`);
    const data = await sub.json();
    const forms: string[] = data.filings.recent.form;
    const dates: string[] = data.filings.recent.filingDate;
    const accs: string[]  = data.filings.recent.accessionNumber;
    let filingDate = "", accession = "";
    for (let i = 0; i < forms.length; i++) {
      if (forms[i] === "13F-HR") { filingDate = dates[i]; accession = accs[i]; break; }
    }

    const accClean = accession.replace(/-/g, "");
    const idxUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/${accession}-index.htm`;
    const idxHtml = await (await edgarFetch(idxUrl)).text();

    // New logic: get all matches, prefer non-xslForm, strip xslForm dir
    const allMatches = Array.from(idxHtml.matchAll(/href="([^"]*(?:infotable|[0-9]+)\.xml)"/gi));
    const rawMatch = allMatches.find(m => !m[1].includes("xslForm")) ?? allMatches[0];
    let xmlPath = rawMatch?.[1] ?? "NOT FOUND";
    xmlPath = xmlPath.replace(/xslForm[^/]+\//gi, "");
    if (!xmlPath.startsWith("/")) xmlPath = `/Archives/edgar/data/${cik}/${accClean}/${xmlPath}`;
    const fullXmlUrl = `https://www.sec.gov${xmlPath}`;

    const xml = await (await edgarFetch(fullXmlUrl)).text();
    const infoTableMatches = [...xml.matchAll(/<[^/][^>]*infoTable[^>]*>/gi)];
    const firstOpenTag = infoTableMatches[0]?.[0] ?? "NO MATCH";
    const allHrefs = allMatches.map(m => m[1]);

    return NextResponse.json({
      filingDate, accession,
      idxUrl,
      allHrefs,
      chosenXmlPath: xmlPath,
      fullXmlUrl,
      xmlLength: xml.length,
      xmlFirst300: xml.slice(0, 300),
      infoTableTagCount: infoTableMatches.length,
      firstOpenTag,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) });
  }
}
