import { NextResponse } from "next/server";

export const revalidate = 60;

// Extract tickers (all-caps 1-5 chars) from Reddit post titles
function extractTickers(text: string): string[] {
  const matches = text.match(/\b[A-Z]{1,5}\b/g) ?? [];
  const STOPWORDS = new Set(["I","A","THE","AND","OR","IN","AT","FOR","TO","IS","ARE","WAS","BE","HAS","WE","MY","BY","ITS","ALL","SO","IF","ON","DO","UP","IT","OF","AS","AN","AM","PM","AI","CEO","CFO","US","DD","OP","OG","IMO","ATH","YTD","IPO","EPS","GDP","CPI","ETF","SEC","FDA","FED","WSB","YOLO","FOMO","GET","BUY","SELL","HOLD","PUT","CALL","RIP","WTF","LOL","LMAO"]);
  const freq: Record<string, number> = {};
  matches.forEach(t => {
    if (!STOPWORDS.has(t) && t.length >= 2) freq[t] = (freq[t] ?? 0) + 1;
  });
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => t);
}

export async function GET() {
  try {
    const res = await fetch(
      "https://www.reddit.com/r/wallstreetbets/hot.json?limit=50",
      { headers: { "User-Agent": "WhaleWatcher/1.0" }, next: { revalidate: 60 } }
    );
    const json = await res.json();
    const posts: Array<{title: string; score: number; url: string}> = json.data.children.map((c: any) => ({
      title: c.data.title,
      score: c.data.score,
      url: `https://reddit.com${c.data.permalink}`,
    }));
    const allText = posts.map(p => p.title).join(" ");
    const tickers = extractTickers(allText);
    return NextResponse.json({ tickers, topPosts: posts.slice(0, 5) });
  } catch {
    return NextResponse.json({ tickers: [], topPosts: [] });
  }
}
