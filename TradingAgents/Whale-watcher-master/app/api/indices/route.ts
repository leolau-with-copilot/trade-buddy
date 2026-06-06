import { NextResponse } from "next/server";

const SYMBOLS = [
  { ticker: "SPY",    label: "S&P 500",  type: "index" },
  { ticker: "QQQ",    label: "NASDAQ",   type: "index" },
  { ticker: "DIA",    label: "DOW",      type: "index" },
  { ticker: "BTC-USD",label: "Bitcoin",  type: "crypto" },
  { ticker: "ETH-USD",label: "Ethereum", type: "crypto" },
  { ticker: "^VIX",   label: "VIX",      type: "fear" },
];

async function fetchQuote(ticker: string) {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta ?? {};
    const price     = meta.regularMarketPrice ?? null;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const change    = price != null && prevClose != null ? price - prevClose : null;
    const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
    return { price, change, changePct };
  } catch { return null; }
}

export async function GET() {
  const results = await Promise.all(
    SYMBOLS.map(async (s) => {
      const q = await fetchQuote(s.ticker);
      return { ...s, ...q };
    })
  );
  return NextResponse.json({ indices: results });
}
