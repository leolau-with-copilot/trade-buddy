import { NextResponse } from "next/server";
import { WHALE_WALLETS } from "@/lib/data";

export const revalidate = 300;

async function getBtcBalance(address: string): Promise<number | null> {
  try {
    const r = await fetch(`https://blockstream.info/api/address/${address}`, {
      next: { revalidate: 300 },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const sat = (d.chain_stats?.funded_txo_sum ?? 0) - (d.chain_stats?.spent_txo_sum ?? 0);
    return sat / 1e8;
  } catch { return null; }
}

// Blockscout — no API key required, more permissive than Etherscan
async function getEthBalance(address: string): Promise<number | null> {
  try {
    const r = await fetch(
      `https://eth.blockscout.com/api/v2/addresses/${address}`,
      { next: { revalidate: 300 }, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const weiStr: string = d.coin_balance ?? "0";
    return parseInt(weiStr) / 1e18;
  } catch { return null; }
}

async function getPrices(): Promise<{ btc: number; eth: number; btcChange: number; ethChange: number }> {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true",
      { next: { revalidate: 300 } }
    );
    if (!r.ok) throw new Error();
    const d = await r.json();
    return {
      btc: d.bitcoin?.usd ?? 104000,
      eth: d.ethereum?.usd ?? 2400,
      btcChange: d.bitcoin?.usd_24h_change ?? 0,
      ethChange: d.ethereum?.usd_24h_change ?? 0,
    };
  } catch { return { btc: 104000, eth: 2400, btcChange: 0, ethChange: 0 }; }
}

export async function GET() {
  const [prices, ...balances] = await Promise.all([
    getPrices(),
    ...WHALE_WALLETS.map(w =>
      w.chain === "BTC" ? getBtcBalance(w.address) : getEthBalance(w.address)
    ),
  ]);

  const wallets = WHALE_WALLETS.map((w, i) => {
    const liveBalance = balances[i];
    const balance = liveBalance ?? w.knownBalance ?? 0;
    const price = w.chain === "BTC" ? prices.btc : prices.eth;
    return {
      ...w,
      balance,
      balanceUsd: Math.round(balance * price),
      price,
      balanceLive: liveBalance !== null,
    };
  });

  return NextResponse.json({ wallets, prices });
}
