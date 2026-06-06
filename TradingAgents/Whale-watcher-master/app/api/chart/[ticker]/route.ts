import { NextRequest, NextResponse } from "next/server";

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
};

async function yfFetch(ticker: string, interval: string, range: string) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { cache: "no-store", headers: YF_HEADERS });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.chart?.result?.[0] ?? null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const { ticker } = params;
  const range = req.nextUrl.searchParams.get("range") ?? "3mo";
  const interval = range === "1d" ? "5m" : range === "5d" ? "15m" : "1d";

  try {
    // Fetch chart data for selected range; also fetch 1Y separately for true 52W stats
    const needYearFetch = range !== "1y" && range !== "5y";
    const [chartResult, yearResult] = await Promise.all([
      yfFetch(ticker, interval, range),
      needYearFetch ? yfFetch(ticker, "1d", "1y") : Promise.resolve(null),
    ]);

    if (!chartResult) {
      return NextResponse.json({ error: "No data returned" }, { status: 404 });
    }

    const timestamps: number[] = chartResult.timestamp ?? [];
    const q = chartResult.indicators?.quote?.[0] ?? {};
    const opens:   number[] = q.open   ?? [];
    const highs:   number[] = q.high   ?? [];
    const lows:    number[] = q.low    ?? [];
    const closes:  number[] = q.close  ?? [];
    const volumes: number[] = q.volume ?? [];

    const data = timestamps.map((ts, i) => ({
      date:   new Date(ts * 1000).toISOString().slice(0, 10),
      open:   opens[i]   ?? null,
      high:   highs[i]   ?? null,
      low:    lows[i]    ?? null,
      close:  closes[i]  ?? null,
      volume: volumes[i] ?? null,
    })).filter(d => d.close !== null);

    // True 52W high/low from 1Y data (or current range if already 1Y+)
    const yearQ = yearResult
      ? (yearResult.indicators?.quote?.[0] ?? {})
      : q;
    const yearHighs = (yearQ.high ?? []).filter((v: number) => v != null && !isNaN(v));
    const yearLows  = (yearQ.low  ?? []).filter((v: number) => v != null && !isNaN(v));
    const high52w = yearHighs.length ? Math.max(...yearHighs) : null;
    const low52w  = yearLows.length  ? Math.min(...yearLows)  : null;

    const meta      = chartResult.meta ?? {};
    const price     = meta.regularMarketPrice ?? meta.previousClose ?? null;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const change    = price != null && prevClose != null ? price - prevClose : null;
    const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
    const volume    = meta.regularMarketVolume ?? null;

    return NextResponse.json({
      ticker,
      data,
      meta: { price, change, changePct, high52w, low52w, volume },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Unknown error" }, { status: 500 });
  }
}
