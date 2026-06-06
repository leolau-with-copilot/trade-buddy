import { NextResponse } from "next/server";

export const revalidate = 300; // cache 5 min

export async function GET() {
  try {
    const res = await fetch(
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://edition.cnn.com/markets/fear-and-greed",
        },
        next: { revalidate: 300 },
      }
    );
    const data = await res.json();
    const fg = data.fear_and_greed;
    return NextResponse.json({
      score: Math.round(fg.score),
      rating: fg.rating,       // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
      prev_week: Math.round(data.fear_and_greed_historical?.data?.slice(-8, -1)?.[0]?.[1] ?? fg.score),
    });
  } catch {
    return NextResponse.json({ score: 50, rating: "Neutral", prev_week: 50 });
  }
}
