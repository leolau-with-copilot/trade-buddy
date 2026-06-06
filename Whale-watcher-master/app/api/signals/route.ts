import { NextResponse } from "next/server";

export const revalidate = 300; // 5 min cache

interface SignalResult {
  ticker: string;
  score: number;           // -6 to +10
  rating: "STRONG BUY" | "BUY" | "WATCH" | "NEUTRAL" | "CAUTION" | "AVOID";
  entryPrice: number | null;
  stopLoss: number | null;
  target: number | null;
  stopPct: number;
  targetPct: number;
  riskReward: number;
  signals: {
    congressBuys: number;
    congressSells: number;
    insiderBuys: number;
    insiderSells: number;
    callsVsPuts: "bullish" | "bearish" | "neutral" | "unknown";
    fearGreed: number;
  };
  contributors: string[];
}

// Fetch congress trades via QuiverQuant (same source as /api/congress)
async function getCongressTrades() {
  try {
    const res = await fetch("https://api.quiverquant.com/beta/live/congresstrading", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WhaleWatcher/1.0)", "Accept": "application/json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any[] = await res.json();
    // Normalize to a common shape
    return raw.map(t => ({
      ticker: t.Ticker ?? "--",
      type: (t.Transaction ?? "purchase").toLowerCase().includes("sale") ? "sale" : "purchase",
      transaction_date: t.TransactionDate ?? t.ReportDate ?? "",
    }));
  } catch { return []; }
}

// Fetch insider buys from SEC EDGAR Atom feed
async function getInsiderBuys(): Promise<string[]> {
  // Map of CIK → ticker for common large-caps
  const CIK_TO_TICKER: Record<string, string> = {
    "320193": "AAPL", "789019": "MSFT", "1045810": "NVDA", "1318605": "TSLA",
    "1326801": "META", "1018724": "AMZN", "1652044": "GOOGL", "2488": "AMD",
    "19617": "JPM", "886982": "GS", "70858": "BAC", "1065280": "NFLX",
    "1321655": "PLTR", "1679788": "COIN", "1403161": "V", "1141391": "MA",
  };
  try {
    const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=40&output=atom";
    const res = await fetch(url, {
      headers: { "User-Agent": "WhaleWatcher/1.0 (yoann.russev@gmail.com)" },
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const cikMatches = [...xml.matchAll(/CIK=(\d+)/gi)];
    const tickers = cikMatches
      .map(m => CIK_TO_TICKER[m[1]])
      .filter((t): t is string => !!t);
    return [...new Set(tickers)];
  } catch { return []; }
}

// Fetch current prices — Polygon grouped daily (one call = all stocks, free tier)
async function getPrices(tickers: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  const apiKey = process.env.POLYGON_API_KEY?.trim();
  const tickerSet = new Set(tickers);

  if (apiKey) {
    try {
      // One call fetches ALL US stocks — cache 1hr, filter locally
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${yesterday}?adjusted=true&apiKey=${apiKey}`;
      const res = await fetch(url, { next: { revalidate: 3600 } });
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json = await res.json() as any;
        for (const bar of json?.results ?? []) {
          if (tickerSet.has(bar.T) && bar.c) prices[bar.T] = bar.c;
        }
      }
    } catch { /* fall through */ }
  }

  // Fallback: Yahoo Finance spark for missing tickers
  const missing = tickers.filter(t => !prices[t]);
  if (missing.length > 0) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${missing.join(",")}&range=1d&interval=1d`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 60 } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = await res.json() as any;
      for (const item of json?.spark?.result ?? []) {
        const closes: (number | null)[] = item?.response?.[0]?.indicators?.quote?.[0]?.close ?? [];
        const last = closes.filter(x => x != null).slice(-1)[0];
        if (last) prices[item.symbol] = last as number;
      }
    } catch { /* ignore */ }
  }

  return prices;
}

// Fetch Fear & Greed
async function getFearGreed(): Promise<number> {
  try {
    const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://edition.cnn.com/markets/fear-and-greed" },
      next: { revalidate: 300 },
    });
    const data = await res.json();
    return Math.round(data.fear_and_greed?.score ?? 50);
  } catch { return 50; }
}

function getRating(score: number): SignalResult["rating"] {
  if (score >= 7) return "STRONG BUY";
  if (score >= 4) return "BUY";
  if (score >= 1) return "WATCH";
  if (score >= -1) return "NEUTRAL";
  if (score >= -3) return "CAUTION";
  return "AVOID";
}

export async function GET() {
  try {
    const [trades, insiderBuys, fearGreed] = await Promise.all([
      getCongressTrades(),
      getInsiderBuys(),
      getFearGreed(),
    ]);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 365); // last 365 days (Congress disclosure can lag 45+ days)

    // Group congress trades by ticker
    const tickerMap: Record<string, { buys: number; sells: number }> = {};
    for (const trade of trades) {
      const ticker = trade.ticker;
      if (!ticker || ticker === "--" || ticker.length > 5) continue;
      const date = new Date(trade.transaction_date ?? "");
      if (isNaN(date.getTime()) || date < cutoff) continue;
      if (!tickerMap[ticker]) tickerMap[ticker] = { buys: 0, sells: 0 };
      if (trade.type === "purchase") tickerMap[ticker].buys++;
      else tickerMap[ticker].sells++;
    }

    // Get top 30 tickers by activity
    const topTickers = Object.entries(tickerMap)
      .map(([ticker, v]) => ({ ticker, ...v, total: v.buys + v.sells }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 30)
      .map(t => t.ticker);

    // Fetch prices
    const prices = await getPrices(topTickers);

    const insiderSet = new Set(insiderBuys);

    // Score each ticker
    const results: SignalResult[] = [];
    for (const ticker of topTickers) {
      const { buys, sells } = tickerMap[ticker];
      const price = prices[ticker] ?? null;
      const contributors: string[] = [];

      let score = 0;

      // Congress signal (max ±4)
      if (buys >= 5) { score += 4; contributors.push(`Congress: ${buys} buys`); }
      else if (buys >= 3) { score += 3; contributors.push(`Congress: ${buys} buys`); }
      else if (buys >= 1) { score += 2; contributors.push(`Congress: ${buys} buy`); }
      if (sells >= 5) { score -= 3; contributors.push(`Congress: ${sells} sells`); }
      else if (sells >= 3) { score -= 2; }
      else if (sells >= 1 && buys === 0) { score -= 1; }

      // Insider signal (max +2)
      if (insiderSet.has(ticker)) {
        score += 2;
        contributors.push("Insider buying");
      }

      // Fear & Greed context (±1)
      let fgSignal: "bullish" | "bearish" | "neutral" | "unknown" = "neutral";
      if (fearGreed <= 25) { score += 1; fgSignal = "bullish"; contributors.push("Extreme Fear (contrarian buy)"); }
      else if (fearGreed >= 75) { score -= 1; fgSignal = "bearish"; }

      const rating = getRating(score);

      // Calculate entry/exit levels based on rating
      let stopPct = 0, targetPct = 0;
      if (rating === "STRONG BUY") { stopPct = 5; targetPct = 20; }
      else if (rating === "BUY") { stopPct = 4; targetPct = 15; }
      else if (rating === "WATCH") { stopPct = 3; targetPct = 10; }
      else if (rating === "CAUTION") { stopPct = 5; targetPct = 8; }
      else if (rating === "AVOID") { stopPct = 8; targetPct = 5; }

      const entryPrice = price;
      const stopLoss = price ? Math.round(price * (1 - stopPct / 100) * 100) / 100 : null;
      const target = price ? Math.round(price * (1 + targetPct / 100) * 100) / 100 : null;
      const riskReward = stopPct > 0 ? Math.round((targetPct / stopPct) * 10) / 10 : 0;

      results.push({
        ticker,
        score,
        rating,
        entryPrice,
        stopLoss,
        target,
        stopPct,
        targetPct,
        riskReward,
        signals: { congressBuys: buys, congressSells: sells, insiderBuys: insiderSet.has(ticker) ? 1 : 0, insiderSells: 0, callsVsPuts: fgSignal, fearGreed },
        contributors,
      });
    }

    // Sort: strong buys first, then by score desc
    results.sort((a, b) => b.score - a.score);

    return NextResponse.json({ signals: results, fearGreed, insiderCount: insiderBuys.length, lastUpdated: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ signals: [], error: String(e) });
  }
}
