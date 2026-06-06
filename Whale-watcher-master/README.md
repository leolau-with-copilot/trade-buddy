# 🐋 Whale Watcher

> **Track the smart money. Follow the whales.**

A real-time financial intelligence dashboard that tracks what Congress members, famous investors, and corporate insiders are buying and selling — before it moves the market.

**🚀 Live demo → [whale-watcher-xi.vercel.app](https://whale-watcher-xi.vercel.app)**

---

## 📸 Features

| Page | Description | Data Source |
|------|-------------|-------------|
| **Dashboard** | Fear & Greed index, live indices, WSB buzz, market news | CNN, Yahoo Finance, Reddit |
| **Congress** | STOCK Act trades by US senators & representatives | SEC EDGAR / QuiverQuant |
| **Famous Investors** | Warren Buffett, Michael Burry, Bill Ackman, Cathie Wood | SEC EDGAR 13F + ARK daily |
| **Insiders** | Real open-market buys & sells from SEC Form 4 filings | SEC EDGAR EFTS |
| **Options Flow** | Live options chains with Black-Scholes pricing | MarketData.app + Yahoo |
| **Dark Pool** | FINRA Reg SHO short volume — bullish/bearish signals | FINRA |
| **Signal Engine** | Composite score: congress + insider + macro sentiment | Multi-source |
| **Heatmap** | 114 tickers across 5 groups, 1-second live refresh | Yahoo Finance |
| **Market Calendar** | FOMC, CPI, NFP, GDP, Earnings — with consensus forecasts | Curated |
| **Crypto Whales** | On-chain BTC & ETH balances of known whale wallets | Blockstream / Blockscout |

---

## 🛠 Tech Stack

- **Framework** — [Next.js 14](https://nextjs.org) (App Router)
- **Styling** — Tailwind CSS + custom dark theme
- **Charts** — Recharts
- **Icons** — Lucide React
- **Fonts** — JetBrains Mono + Geist
- **Deployment** — Vercel

---

## 🚀 Quick Start

### Option 1 — View live (no setup needed)

Just visit **[whale-watcher-xi.vercel.app](https://whale-watcher-xi.vercel.app)** — no account, no login.

### Option 2 — Run locally

```bash
# Clone the repo
git clone https://github.com/YoannRussev/Whale-watcher.git
cd Whale-watcher

# Install dependencies
npm install

# Start the dev server
npm run dev
```

Then open [http://localhost:3008](http://localhost:3008) in your browser.

### Environment Variables (optional)

The app works without any API keys using free public endpoints. For enhanced options data you can add:

```env
# .env.local
POLYGON_API_KEY=your_key_here     # Better stock price coverage
TRADIER_TOKEN=your_token_here     # Full live options chains (all tickers)
```

---

## 📡 Data Sources

All data is fetched live from public APIs — no database, no scraping.

| Source | What it powers | Cost |
|--------|---------------|------|
| [SEC EDGAR](https://www.sec.gov/cgi-bin/browse-edgar) | Congress trades, 13F filings, Form 4 insider trades | Free |
| [FINRA Reg SHO](https://www.finra.org/finra-data/browse-catalog/short-sale-volume-data) | Dark pool short volume | Free |
| [Yahoo Finance](https://finance.yahoo.com) | Live stock & crypto quotes | Free |
| [CoinGecko](https://www.coingecko.com/en/api) | BTC/ETH prices | Free |
| [Blockstream](https://blockstream.info/api/) | On-chain Bitcoin balances | Free |
| [Blockscout](https://eth.blockscout.com) | On-chain Ethereum balances | Free |
| [CNN Fear & Greed](https://edition.cnn.com/markets/fear-and-greed) | Market sentiment index | Free |
| [QuiverQuant](https://www.quiverquant.com) | Congress trade aggregation | Free tier |
| [ARKfunds.io](https://arkfunds.io/api) | Cathie Wood daily holdings | Free |

---

## ⚠️ Disclaimer

> This tool is for **informational purposes only** and does not constitute financial advice. All data is sourced from public disclosures and may be delayed. Do your own research before making any investment decisions.

---

<div align="center">
  <sub>Built with ❤️ · Data from public disclosures · Not financial advice</sub>
</div>
