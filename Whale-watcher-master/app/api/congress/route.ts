import { NextResponse } from "next/server";
import { CONGRESS_FALLBACK } from "@/lib/data";

export const revalidate = 1800; // 30 min

// Quiver Quant free endpoint — returns live STOCK Act disclosures
// Data includes ExcessReturn vs SPY, which is genuinely useful
async function fetchQuiverQuant() {
  const res = await fetch("https://api.quiverquant.com/beta/live/congresstrading", {
    next: { revalidate: 1800 },
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; WhaleWatcher/1.0)",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`QQ HTTP ${res.status}`);
  const raw: any[] = await res.json();
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("empty");
  return raw;
}

function mapTrade(t: any, i: number) {
  const txType = (t.Transaction ?? "Purchase").toLowerCase();
  return {
    id: String(i),
    representative: t.Representative ?? "Unknown",
    party: (t.Party ?? "I") as "D" | "R" | "I",
    state: t.State ?? "??",
    chamber: t.House ?? "Representatives",
    ticker: t.Ticker ?? "--",
    assetName: t.Description
      ? t.Description.split(".")[0].substring(0, 60)
      : (t.Ticker ?? "Unknown Asset"),
    type: txType.includes("sale") || txType.includes("sell") ? "sale" : "purchase",
    amount: t.Range ?? t.Amount ?? "$0",
    transactionDate: t.TransactionDate ?? t.ReportDate ?? new Date().toISOString().slice(0, 10),
    disclosureDate: t.ReportDate ?? new Date().toISOString().slice(0, 10),
    sector: t.TickerType === "ST" ? "Stock" : (t.TickerType ?? "Other"),
    // Extra Quiver Quant fields
    excessReturn: typeof t.ExcessReturn === "number" ? +t.ExcessReturn.toFixed(2) : null,
    priceChange: typeof t.PriceChange === "number" ? +t.PriceChange.toFixed(2) : null,
  };
}

export async function GET() {
  try {
    const raw = await fetchQuiverQuant();
    const trades = raw.slice(0, 150).map(mapTrade);
    return NextResponse.json({ trades, source: "live", provider: "QuiverQuant" });
  } catch {
    return NextResponse.json({ trades: CONGRESS_FALLBACK, source: "fallback", provider: "cached" });
  }
}
