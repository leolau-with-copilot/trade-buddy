import { NextResponse } from "next/server";

export const revalidate = 300;

// Yahoo Finance v8/chart works server-side with browser User-Agent
async function fetchPrice(ticker: string): Promise<{ price: number; change: number; changePct: number } | null> {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d&includePrePost=false`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        next: { revalidate: 300 },
      }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const meta = d?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price = meta.regularMarketPrice as number;
    const prev  = meta.chartPreviousClose as number ?? price;
    const change    = price - prev;
    const changePct = prev > 0 ? (change / prev) * 100 : 0;
    return {
      price: Math.round(price * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
    };
  } catch { return null; }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("tickers") ?? "";
  const tickers = raw.split(",").filter(Boolean).slice(0, 30);
  if (!tickers.length) return NextResponse.json({ quotes: {} });

  const results = await Promise.all(tickers.map(t => fetchPrice(t)));
  const quotes: Record<string, { price: number; change: number; changePct: number }> = {};
  for (let i = 0; i < tickers.length; i++) {
    if (results[i]) quotes[tickers[i]] = results[i]!;
  }
  return NextResponse.json({ quotes });
}
