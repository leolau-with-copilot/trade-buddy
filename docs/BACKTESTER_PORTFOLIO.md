# Backtester & Portfolio — setup

Two new pages: **Backtester** (write & run Python strategies) and **Portfolio**
(Alpaca paper trading).

## Backtester

Users write a Python strategy that defines `generate_signals(data)` returning a
per-bar target position (`-1` short, `0` flat, `1` long). `data` is a pandas
DataFrame (`open/high/low/close/volume`); `pd` and `np` are available. The engine
fetches history via yfinance, runs the code, and reports return / Sharpe /
max-drawdown / win-rate / trades plus an equity curve vs. buy-and-hold.

### Sandbox isolation (IMPORTANT on a public server)

User code runs in a **separate subprocess** with:
- a **clean environment** (no `DEEPSEEK_API_KEY`, `ALPACA_*`, etc. — secrets are
  never passed in),
- **resource limits** (CPU seconds, memory, file size, no new procs),
- a **wall-clock timeout**, and a private temp working dir.

For full **filesystem + network isolation** (so code can't read `/opt/trade-buddy/.env`
or call out), install **bubblewrap** — it's tiny (no Docker/RAM overhead):

```bash
dnf install -y bubblewrap        # Alibaba Cloud Linux / RHEL / Anolis
# (apt install -y bubblewrap on Debian/Ubuntu)
```

The engine auto-detects `bwrap` and jails the child with `--unshare-all`
(no network) and a read-only system + temp-dir-only bind. **Without bubblewrap it
logs a warning and runs with only the env+resource limits** (FS/network NOT
isolated). To refuse running unsandboxed, set `BACKTEST_REQUIRE_SANDBOX=1`.

Tunables (env): `BACKTEST_CPU_SECONDS` (10), `BACKTEST_MEM_MB` (512),
`BACKTEST_WALL_SECONDS` (20).

## Portfolio — Alpaca paper trading

Simulated money only (paper endpoint). Get free keys at
<https://alpaca.markets> → Paper Trading → API Keys, then add to `.env`:

```
ALPACA_API_KEY=...
ALPACA_SECRET_KEY=...
```

Install the SDK and restart:

```bash
cd /opt/trade-buddy && . .venv/bin/activate
pip install alpaca-py
```

The Portfolio page shows account equity/cash/buying-power/day-P&L, open
positions with unrealised P&L, recent orders, and a place-order form
(market/limit, buy/sell). If keys are missing it shows a setup notice instead of
erroring.

## LEAN (deferred)

LEAN (QuantConnect) is the eventual "gold standard" engine (Docker + the `lean`
CLI). It needs ~4GB RAM and a multi-GB Docker image, so it's **deferred until the
app runs on a larger host** than the current 1.8GB SWAS instance — and the LEAN
source / data-converter were **removed** from the repo so they aren't deployed.
The lightweight sandboxed engine above is the active backtester. To revisit LEAN
later, re-clone QuantConnect/Lean on a bigger box and run it via Docker.
