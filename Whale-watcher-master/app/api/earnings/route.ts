import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ticker = searchParams.get("ticker") ?? "AAPL";

  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=earningsHistory,earningsTrend,defaultKeyStatistics`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      next: { revalidate: 3600 },
    });
    const json = await res.json();
    const result = json.quoteSummary?.result?.[0];

    const history = (result?.earningsHistory?.history ?? []).map((h: any) => ({
      quarter: h.period,
      date: h.earningsDate?.fmt ?? "",
      epsEst: h.epsEstimate?.raw ?? null,
      epsActual: h.epsActual?.raw ?? null,
      surprise: h.surprisePercent?.raw ?? null,
    })).reverse();

    const trend = result?.earningsTrend?.trend?.[0];
    const nextEarnings = {
      date: trend?.earningsDate?.[0]?.fmt ?? null,
      epsEst: trend?.earningsEstimate?.avg?.raw ?? null,
      revenueEst: trend?.revenueEstimate?.avg?.raw ?? null,
    };

    const stats = result?.defaultKeyStatistics;
    const peRatio = stats?.forwardPE?.raw ?? null;
    const pegRatio = stats?.pegRatio?.raw ?? null;

    return NextResponse.json({ history, nextEarnings, peRatio, pegRatio });
  } catch {
    return NextResponse.json({ history: [], nextEarnings: null, peRatio: null, pegRatio: null });
  }
}
