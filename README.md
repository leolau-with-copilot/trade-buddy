<p align="center">
  <img src="webapp/static/bull.png" alt="Trade Buddy" width="140">
</p>

<h1 align="center">Trade Buddy</h1>

<p align="center">
  An AI trading research desk in your browser — multi-agent stock analysis,
  live market data, congressional &amp; dark-pool flow, paper trading, and a
  strategy backtester, all behind one FastAPI web app.
</p>

---

## What it is

Trade Buddy is a single-page web app backed by a multi-agent analysis engine.
Ask it about a ticker and a team of LLM agents (built on **AutoGen 0.4** over
**DeepSeek**) researches it end to end — then explore the supporting market data,
smart-money flow, your paper-trading portfolio, and a sandboxed backtester from
the same dashboard.

It is the product layer on top of a re-architected `tradingagents` pipeline:
**Analysts → Bull/Bear debate → Judge**, where the Judge grades every claim
against real data and a backtested signal win-rate, then emits a scored verdict.

## Features

- **AI analysis** — four tool-using analysts (technical, fundamentals, news,
  sentiment) feed a Bull vs. Bear debate (Tree-of-Thoughts + historical win-rate
  grounding); a **Judge** verifies the claims, builds a weighted scoreboard, and
  issues a rated verdict. Every run is persisted to a SQLite analysis store.
- **Trade Buddy chat** — converse with an agent that has the same data tools and
  can run a full analysis on demand.
- **Dashboard & markets** — quotes, technical signals, financials/statements,
  company overview, peers, global market panels, indices, movers, sectors.
- **Whale watching** — congressional trades (House & Senate, time-sorted with
  aggregate analysis), dark-pool flow (FINRA), institutional holders & big-whale
  positions, insider activity.
- **Unified calendar** — earnings, economic releases, and news in one calendar
  view, each event linking to its real source.
- **Portfolio** — live **Alpaca paper-trading** account, positions, orders, and
  an equity curve with hover-to-inspect returns.
- **Backtester** — write a strategy and run it in a locked-down sandbox.
- **Watchlist, screener, news tape, price alerts, settings.**
- **Multi-language UI** — English, 简体中文, 繁體中文, Français.
- **Invitation-gated auth** so you control who can sign in.

## Quick start

Requires Python 3.11+.

```bash
# 1. Install
pip install -e .

# 2. Configure (see the table below) — copy the example and fill it in
cp .env.example .env
$EDITOR .env

# 3. Run the web app
python -m webapp
# → http://127.0.0.1:8000
```

To expose it on a network interface:

```bash
TRADINGAGENTS_WEB_HOST=0.0.0.0 TRADINGAGENTS_WEB_PORT=8000 python -m webapp
```

The command-line analysis tool is also available:

```bash
python -m cli.main          # interactive analysis in the terminal
```

## Configuration

Set these in `.env` (loaded at startup). The analysis engine needs a DeepSeek
key; everything else unlocks the corresponding feature.

| Variable | Purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` | **Required.** Powers the analysis agents and chat. |
| `FINNHUB_API_KEY` | Market data, economic calendar, company info. |
| `FMP_API_KEY` / `TIINGO_API_KEY` | Additional market-data vendors. |
| `ALPACA_API_KEY_ID` + `ALPACA_API_SECRET_KEY` | Alpaca **paper** trading (portfolio, orders). |
| `TB_INVITED_CODE` | Invitation code required to sign in. |
| `TB_GUEST_CODE` | Optional read-only guest code. |
| `TB_SESSION_SECRET` | Secret used to sign login sessions — treat like a password. |
| `CLAWBOT_API_TOKEN` | Shared secret for the optional clawbot bridge routes. |
| `BACKTEST_REQUIRE_SANDBOX` | Set to `1` on any public host to force the backtest sandbox. |
| `TRADINGAGENTS_WEB_HOST` / `TRADINGAGENTS_WEB_PORT` | Web server bind address (default `127.0.0.1:8000`). |

> **Note:** Trading is **paper only** by default (Alpaca paper account). The
> backtester executes user-supplied Python — keep `BACKTEST_REQUIRE_SANDBOX=1`
> on any internet-facing deployment.

## Deployment

`scripts/deploy.sh` rsyncs the app to a VPS over SSH (it carries your real `.env`
over the encrypted channel, never via git, and excludes caches, virtualenvs, and
the heavy reference checkouts):

```bash
scripts/deploy.sh user@your-vps            # deploy to /opt/trade-buddy
DRY_RUN=1 scripts/deploy.sh user@your-vps  # preview the transfer
```

Then on the server: create a venv, `pip install -e .`, set `.env`, and run
`TRADINGAGENTS_WEB_HOST=0.0.0.0 python3 -m webapp` (behind your reverse proxy).

## Project layout

```
tradingagents/   Multi-agent analysis engine (AutoGen + DeepSeek)
  autogen_agents/  analysts, bull/bear debate, judge
  dataflows/       market-data vendors (yfinance, finnhub, finviz, SEC, …)
  datastore/       SQLite analysis store
webapp/          FastAPI server + vanilla-JS single-page app (static/)
cli/             terminal analysis interface
scripts/         deploy.sh and helpers
tests/           pytest suite
```

## License

Apache License 2.0 — see [LICENSE](LICENSE). Built on a re-architected fork of
the TradingAgents framework.
