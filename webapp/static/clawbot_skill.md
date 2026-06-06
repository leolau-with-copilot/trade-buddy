---
name: trade-buddy-bridge
description: >
  Talk to Trade Buddy, the TradingAgents analyst, over HTTP. Use this when the
  user (or your own reasoning) needs equities/macro data, a saved analysis, or a
  fresh multi-agent verdict on a ticker. Trade Buddy holds live market data
  (prices, technicals, fundamentals, financial statements, news/sentiment, SEC
  insider + congressional trades, FRED macro) and a growing database of its own
  past analyses; it can also commission its full analyst team on demand.
---

# Trade Buddy Bridge (openclaw clawbot skill)

This skill is the transmission path between the **openclaw clawbot** and **Trade
Buddy**, the analyst agent inside the TradingAgents webapp. Trade Buddy is the
data + analysis brain; the clawbot reaches it over a small HTTP API. Every
exchange is logged to a shared database, so Trade Buddy remembers the
conversation across calls.

## Base URL

```
TRADE_BUDDY_URL   default https://leotradebuddy.duckdns.org
```

All paths below are relative to that base. Requests and responses are JSON
(`Content-Type: application/json`) unless noted.

## Authentication

If the server has `CLAWBOT_API_TOKEN` set (it will be, on any public/tunnelled
deployment), every `/api/clawbot/*` request must carry the shared secret:

```
X-Trade-Buddy-Token: <your CLAWBOT_API_TOKEN>
```

The token is a shared secret — it lives in the server's `CLAWBOT_API_TOKEN` env
var and in the clawbot's own secrets (e.g. `$TRADE_BUDDY_TOKEN`). Never paste the
real value here; this file is served publicly under `/static`.

`Authorization: Bearer <token>` is accepted too. Missing/wrong token → **HTTP
401** `{"detail": "invalid or missing clawbot token"}`. On a localhost dev server
where the env var is unset, auth is disabled and the header is optional.

```bash
# the token lives in the clawbot's own secrets, e.g. $TRADE_BUDDY_TOKEN
curl -s "$TRADE_BUDDY_URL/api/clawbot/chat" \
  -H "Content-Type: application/json" \
  -H "X-Trade-Buddy-Token: $TRADE_BUDDY_TOKEN" \
  -d '{"message": "Is NVDA a buy?", "session_id": "openclaw-abc123"}'
```

## When to use this skill

- The user asks anything about a stock, the market, the economy, smart-money
  flows, or a company's fundamentals/news → **chat** with Trade Buddy.
- The user wants a recorded, rigorous verdict on a ticker, or asks "what does
  the analyst team think of X" → **commission an analysis** (or fetch the saved
  one first).
- You need to recall something discussed earlier → **read the conversation log**.

Do **not** fabricate market figures yourself. Route the question to Trade Buddy;
it answers only from its tools and cites real numbers with dates.

---

## 1. Chat with Trade Buddy

`POST /api/clawbot/chat`

```json
{
  "message": "Is NVDA a buy right now? Use fundamentals + smart money.",
  "session_id": "openclaw-abc123",
  "ticker": "NVDA"
}
```

| field        | required | notes                                                            |
|--------------|----------|------------------------------------------------------------------|
| `message`    | yes      | The user's question, in natural language.                        |
| `session_id` | no       | Stable id for this conversation. If omitted, one is returned — reuse it on every follow-up so Trade Buddy keeps context. |
| `ticker`     | no       | Tags the turn with a symbol (helps later recall).                |
| `history`    | no       | `[{role, content}]`. Omit it — the server replays this session's stored history automatically. |

**Response**

```json
{ "reply": "NVDA — leaning constructive. ...", "session_id": "openclaw-abc123" }
```

`reply` is finished prose with real figures and their as-of dates. Relay it to
the user. Persist `session_id` and send it back on the next turn.

Trade Buddy decides per message which of its tools to use: live prices &
technical indicators, fundamentals & financial statements, news/sentiment, FRED
macro, SEC Form 4 insider trades, congressional (STOCK Act) trades, its analysis
database, and the conversation log. You don't pick tools — just ask in plain
language.

> A chat turn that triggers several tool lookups can take 10–40s. Use a request
> timeout of **≥ 90s**.

---

## 2. Commission the full analyst team (background job)

Use this when the user wants a fresh, rigorous verdict and a quick chat answer
isn't enough. It runs the entire pipeline — **Analysts → Bull/Bear debate →
Judge** — which takes **a few minutes**, so it is a background job you poll. The
result is saved to the database automatically.

**Start it**

`POST /api/clawbot/analyze`

```json
{ "ticker": "NVDA", "research_depth": 3 }
```

| field            | required | default     | notes                                   |
|------------------|----------|-------------|-----------------------------------------|
| `ticker`         | yes      | —           | Symbol to analyze.                      |
| `date`           | no       | today       | `YYYY-MM-DD` as-of date.                |
| `research_depth` | no       | `3`         | Bull/Bear debate rounds (1–5).          |
| `provider`       | no       | `deepseek`  | LLM provider.                           |
| `language`       | no       | `English`   | Output language of the verdict.         |

Response:

```json
{ "job_id": "f3a1c2b4d5e6", "ticker": "NVDA", "status": "running",
  "poll": "/api/clawbot/analyze/f3a1c2b4d5e6" }
```

**Poll it**

`GET /api/clawbot/analyze/{job_id}` every ~20–30s until `status` is `done` or
`error`:

```json
{
  "job_id": "f3a1c2b4d5e6", "ticker": "NVDA", "status": "done",
  "result": {
    "ticker": "NVDA", "trade_date": "2026-05-31",
    "rating": "Buy", "weighted_score": 0.62, "decision": "BUY",
    "scoreboard": [ { "metric": "...", "weight": 0.2, "score": 0.8, "note": "..." } ],
    "verdict_md": "## Verdict ...", "analysis_id": 42,
    "consensus_reached": true
  }
}
```

On `status: "error"` an `error` string explains the failure.

---

## 3. Retrieve a saved analysis

`GET /api/clawbot/analysis?ticker=NVDA`

Returns the most recent saved verdict + scoreboard for the ticker. **Call this
before commissioning a new run** — if a recent analysis exists, reuse it instead
of paying for another multi-minute pipeline.

```json
{ "ticker": "NVDA", "found": true, "trade_date": "2026-05-31",
  "rating": "Buy", "weighted_score": 0.62,
  "verdict_md": "...", "scoreboard": [ ... ], "created_at": "2026-05-31T..." }
```

`{ "found": false }` means nothing is stored yet — then chat, or commission a
run.

---

## 4. Read the conversation log

`GET /api/clawbot/conversations`

| query        | notes                                                       |
|--------------|-------------------------------------------------------------|
| `session_id` | All turns in one conversation (oldest→newest).              |
| `channel`    | Filter by channel (`clawbot` or `dashboard`).               |
| `query`      | Substring search across all message text.                   |
| `limit`      | Max rows (default 30, max 200).                             |

```json
{ "messages": [ { "channel": "clawbot", "session_id": "openclaw-abc123",
  "role": "user", "ticker": "NVDA", "content": "Is NVDA a buy?",
  "created_at": "2026-05-31T12:00:00+00:00" } ], "count": 1 }
```

Trade Buddy reads this same log internally, so you rarely need it — but it's
useful for audit, resuming a session, or showing history.

---

## Recommended flow

```
user asks about a ticker
        │
        ├─ quick question?  ── POST /api/clawbot/chat  (reuse session_id) ──► relay reply
        │
        └─ wants a rigorous verdict?
                 │
                 ├─ GET /api/clawbot/analysis?ticker=…   (recent one saved?) ──► relay it
                 │
                 └─ none/stale ─ POST /api/clawbot/analyze ─► poll GET /analyze/{job_id}
                                  until done ──► relay result.verdict_md + rating
```

## Conventions & guardrails

- **Always reuse `session_id`** for a continuing conversation so Trade Buddy
  keeps context; mint a new one per distinct conversation.
- **Prefer saved analyses** over new runs to save time and cost; only commission
  a run when there's nothing recent or the user explicitly wants a fresh one.
- **Never invent numbers.** If Trade Buddy says data is unavailable, relay that —
  don't fill the gap with a guess.
- **Timeouts:** chat ≥ 90s; analysis is async, so the start/poll calls are fast.
- **Errors:** a bad/missing token returns **401**; other failures generally
  return **200** with a JSON `error` (or `found: false`) field rather than a
  non-200. Check both and surface a graceful message.
