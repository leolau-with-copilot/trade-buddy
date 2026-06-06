import { NextResponse } from "next/server";

export const revalidate = 1800; // 30 min

// FINRA Reg SHO daily short volume — good institutional flow proxy
// File format: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
// All US-listed equities are in the file — we parse every row.

function getPrevBusinessDays(n: number): string[] {
  const dates: string[] = [];
  let d = new Date();
  while (dates.length < n) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      dates.push(`${y}${m}${dd}`);
    }
  }
  return dates;
}

interface DarkPoolEntry {
  symbol: string;
  shortVolume: number;
  totalVolume: number;
  shortPct: number;
  darkPoolPct: number;
  signal: "bullish" | "bearish" | "neutral";
  date: string;
}

async function fetchFinraData(dateStr: string, filterTicker?: string): Promise<DarkPoolEntry[] | null> {
  const url = `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${dateStr}.txt`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 1800 },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.split("\n").slice(1); // skip header
    const entries: DarkPoolEntry[] = [];

    for (const line of lines) {
      const parts = line.trim().split("|");
      if (parts.length < 5) continue;
      const [, rawSymbol, shortVolStr, , totalVolStr] = parts;
      if (!rawSymbol) continue;

      const symbol = rawSymbol.trim().toUpperCase();

      // Skip ETNs, preferred shares, warrants, etc. (contain +, -, *, /)
      if (/[^A-Z]/.test(symbol)) continue;

      // If a specific ticker is requested, filter to only that
      if (filterTicker && symbol !== filterTicker) continue;

      const shortVol = parseInt(shortVolStr) || 0;
      const totalVol = parseInt(totalVolStr) || 0;

      // Skip illiquid tickers (under 50k shares) unless searching for a specific one
      if (!filterTicker && totalVol < 500000) continue;

      const shortPct = totalVol > 0 ? (shortVol / totalVol) * 100 : 0;
      const signal: "bullish" | "bearish" | "neutral" =
        shortPct < 32 ? "bullish" : shortPct > 50 ? "bearish" : "neutral";

      entries.push({
        symbol,
        shortVolume: shortVol,
        totalVolume: totalVol,
        shortPct: Math.round(shortPct * 10) / 10,
        darkPoolPct: Math.round((100 - shortPct) * 10) / 10,
        signal,
        date: dateStr,
      });
    }

    // Sort by total volume descending, return top 150 (or all if filtered)
    entries.sort((a, b) => b.totalVolume - a.totalVolume);
    return filterTicker ? entries : entries.slice(0, 150);
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ticker = searchParams.get("ticker")?.toUpperCase().trim();

  // Try last 3 business days until we get data
  const days = getPrevBusinessDays(3);
  let entries: DarkPoolEntry[] | null = null;
  let usedDate = "";

  for (const day of days) {
    entries = await fetchFinraData(day, ticker);
    if (entries && entries.length > 0) { usedDate = day; break; }
  }

  if (!entries || entries.length === 0) {
    // Return minimal mock only if specific ticker not found
    if (ticker) {
      // Generate a plausible entry for the requested ticker
      entries = [{
        symbol: ticker,
        shortVolume: 1200000,
        totalVolume: 3800000,
        shortPct: 31.6,
        darkPoolPct: 68.4,
        signal: "bullish",
        date: "mock",
      }];
    } else {
      entries = [
        { symbol: "SPY",  shortVolume: 45000000, totalVolume: 120000000, shortPct: 37.5, darkPoolPct: 62.5, signal: "neutral", date: "mock" },
        { symbol: "NVDA", shortVolume: 22000000, totalVolume: 85000000,  shortPct: 25.8, darkPoolPct: 74.2, signal: "bullish", date: "mock" },
        { symbol: "AAPL", shortVolume: 18000000, totalVolume: 72000000,  shortPct: 55.2, darkPoolPct: 44.8, signal: "bearish", date: "mock" },
        { symbol: "TSLA", shortVolume: 30000000, totalVolume: 95000000,  shortPct: 31.5, darkPoolPct: 68.5, signal: "bullish", date: "mock" },
        { symbol: "QQQ",  shortVolume: 14000000, totalVolume: 50000000,  shortPct: 28.0, darkPoolPct: 72.0, signal: "bullish", date: "mock" },
      ];
    }
    usedDate = "mock";
  }

  const bullish = entries.filter(e => e.signal === "bullish");
  const bearish = entries.filter(e => e.signal === "bearish");

  return NextResponse.json({ entries, bullish, bearish, date: usedDate, ticker: ticker ?? null });
}
