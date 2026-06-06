import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ticker = searchParams.get("ticker") ?? "SPY";

  try {
    const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    const res = await fetch(rssUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 60 },
    });
    const xml = await res.text();

    // Parse items from RSS XML
    const items: Array<{ title: string; link: string; pubDate: string; source: string }> = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
      const block = m[1];
      const title = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
        ?? block.match(/<title>(.*?)<\/title>/)?.[1] ?? "";
      const link = block.match(/<link>(.*?)<\/link>/)?.[1]
        ?? block.match(/<guid>(.*?)<\/guid>/)?.[1] ?? "";
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? "";
      const source = block.match(/<source[^>]*>(.*?)<\/source>/)?.[1] ?? "Yahoo Finance";
      if (title) items.push({ title: title.trim(), link: link.trim(), pubDate: pubDate.trim(), source: source.trim() });
    }

    return NextResponse.json({ items: items.slice(0, 12) });
  } catch {
    return NextResponse.json({ items: [] });
  }
}
