"""SQLite-backed dataset of analyses, scoreboards, signals, and outcomes.

Schema (one DB at ``~/.tradingagents/cache/analysis_store.db`` by default):

* ``analyses``     — one row per completed analysis (ticker, date, verdict, rating)
* ``scoreboard``   — the Judge's weighted metric rows for each analysis
* ``signals``      — the technical-intuition signals the researchers cited, with
                     the claimed vs. backtested win rate
* ``outcomes``     — realised return/alpha, filled in on a later same-ticker run
* ``winrate_cache``— memoised technical win-rate backtests

Each method opens its own short-lived connection so the store is safe to call
from AutoGen's async/threaded execution without sharing a connection object.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS analyses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker         TEXT NOT NULL,
    trade_date     TEXT NOT NULL,
    asset_type     TEXT NOT NULL DEFAULT 'stock',
    final_rating   TEXT,
    weighted_score REAL,
    verdict_md     TEXT,
    created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scoreboard (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    metric      TEXT NOT NULL,
    source      TEXT,
    raw_value   TEXT,
    weight      REAL,
    score       REAL,
    note        TEXT
);
CREATE TABLE IF NOT EXISTS signals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id      INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    side             TEXT,              -- 'bull' or 'bear'
    indicator        TEXT,
    signal           TEXT,
    claimed_winrate  REAL,
    backtest_winrate REAL,
    n_occurrences    INTEGER
);
CREATE TABLE IF NOT EXISTS outcomes (
    analysis_id  INTEGER PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    raw_return   REAL,
    alpha_return REAL,
    holding_days INTEGER,
    benchmark    TEXT,
    resolved_at  TEXT
);
CREATE TABLE IF NOT EXISTS winrate_cache (
    ticker             TEXT NOT NULL,
    signal             TEXT NOT NULL,
    as_of_date         TEXT NOT NULL,
    horizon_days       INTEGER NOT NULL,
    lookback_years     INTEGER NOT NULL,
    hit_rate           REAL,
    n_occurrences      INTEGER,
    avg_forward_return REAL,
    PRIMARY KEY (ticker, signal, as_of_date, horizon_days, lookback_years)
);
-- Conversation log: every message exchanged with Trade Buddy, on any channel
-- (the dashboard chat, or the 'clawbot' transmission path). The analyst agent
-- reads this back so it remembers prior turns across stateless HTTP requests.
CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel     TEXT NOT NULL,        -- 'clawbot', 'dashboard', …
    session_id  TEXT,                 -- caller-supplied conversation id
    role        TEXT NOT NULL,        -- 'user' | 'assistant'
    ticker      TEXT,                 -- optional symbol the turn is about
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_ticker ON analyses(ticker);
CREATE INDEX IF NOT EXISTS idx_signals_signal ON signals(signal);
CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_channel ON conversations(channel);
"""


def default_store_path(data_cache_dir: str) -> str:
    """Default DB location under the configured data cache directory."""
    return os.path.join(data_cache_dir, "analysis_store.db")


class AnalysisStore:
    """CRUD over the analysis dataset. Construct once, call from anywhere."""

    def __init__(self, db_path: str):
        self.db_path = str(db_path)
        Path(self.db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as conn:
            conn.executescript(_SCHEMA)

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    # --- write: an analysis result ------------------------------------------

    def record_analysis(
        self,
        *,
        ticker: str,
        trade_date: str,
        asset_type: str = "stock",
        final_rating: Optional[str] = None,
        weighted_score: Optional[float] = None,
        verdict_md: Optional[str] = None,
        scoreboard: Optional[Iterable[dict]] = None,
        signals: Optional[Iterable[dict]] = None,
    ) -> int:
        """Insert an analysis plus its scoreboard rows and cited signals.

        ``scoreboard`` rows accept keys: metric, source, raw_value, weight,
        score, note. ``signals`` rows accept: side, indicator, signal,
        claimed_winrate, backtest_winrate, n_occurrences. Returns the new
        ``analyses.id``.
        """
        with self._conn() as conn:
            cur = conn.execute(
                "INSERT INTO analyses (ticker, trade_date, asset_type, "
                "final_rating, weighted_score, verdict_md, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (ticker, str(trade_date), asset_type, final_rating,
                 weighted_score, verdict_md, self._now()),
            )
            analysis_id = int(cur.lastrowid)

            for row in scoreboard or []:
                conn.execute(
                    "INSERT INTO scoreboard (analysis_id, metric, source, "
                    "raw_value, weight, score, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (analysis_id, row.get("metric"), row.get("source"),
                     _to_text(row.get("raw_value")), row.get("weight"),
                     row.get("score"), row.get("note")),
                )
            for row in signals or []:
                conn.execute(
                    "INSERT INTO signals (analysis_id, side, indicator, signal, "
                    "claimed_winrate, backtest_winrate, n_occurrences) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (analysis_id, row.get("side"), row.get("indicator"),
                     row.get("signal"), row.get("claimed_winrate"),
                     row.get("backtest_winrate"), row.get("n_occurrences")),
                )
            return analysis_id

    # --- read: feasibility lookups for the Judge ----------------------------

    def past_analyses(self, ticker: str, limit: int = 5) -> List[dict]:
        """Recent analyses for ``ticker`` with their realised outcome (if known)."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT a.*, o.raw_return, o.alpha_return, o.holding_days, "
                "o.benchmark FROM analyses a LEFT JOIN outcomes o "
                "ON a.id = o.analysis_id WHERE a.ticker = ? "
                "ORDER BY a.trade_date DESC, a.id DESC LIMIT ?",
                (ticker, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    def signal_history_winrate(self, signal: str) -> dict:
        """Realised track record of past analyses that cited ``signal``.

        Joins cited signals to resolved outcomes and reports how often the
        analysis went on to produce positive alpha. This is the "past records"
        half of the Judge's intuition-feasibility check (the other half being
        the live backtest in :mod:`tradingagents.backtest`).
        """
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT o.alpha_return, s.backtest_winrate FROM signals s "
                "JOIN outcomes o ON s.analysis_id = o.analysis_id "
                "WHERE s.signal = ? AND o.alpha_return IS NOT NULL",
                (signal,),
            ).fetchall()
        n = len(rows)
        if n == 0:
            return {"signal": signal, "n": 0, "win_rate": None,
                    "avg_alpha": None, "avg_backtest_winrate": None}
        alphas = [r["alpha_return"] for r in rows]
        backtests = [r["backtest_winrate"] for r in rows if r["backtest_winrate"] is not None]
        wins = sum(1 for a in alphas if a > 0)
        return {
            "signal": signal,
            "n": n,
            "win_rate": wins / n,
            "avg_alpha": sum(alphas) / n,
            "avg_backtest_winrate": (sum(backtests) / len(backtests)) if backtests else None,
        }

    # --- deferred outcome resolution ----------------------------------------

    def pending_outcomes(self, ticker: str) -> List[dict]:
        """Analyses for ``ticker`` that have no realised outcome row yet."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT a.id, a.ticker, a.trade_date FROM analyses a "
                "LEFT JOIN outcomes o ON a.id = o.analysis_id "
                "WHERE a.ticker = ? AND o.analysis_id IS NULL "
                "ORDER BY a.trade_date",
                (ticker,),
            ).fetchall()
            return [dict(r) for r in rows]

    def resolve_outcome(
        self,
        analysis_id: int,
        *,
        raw_return: float,
        alpha_return: float,
        holding_days: int,
        benchmark: str,
    ) -> None:
        """Record the realised return/alpha for a previously stored analysis."""
        with self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO outcomes (analysis_id, raw_return, "
                "alpha_return, holding_days, benchmark, resolved_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (analysis_id, raw_return, alpha_return, holding_days,
                 benchmark, self._now()),
            )

    # --- win-rate cache ------------------------------------------------------

    def get_cached_winrate(
        self, ticker: str, signal: str, as_of_date: str,
        horizon_days: int, lookback_years: int,
    ) -> Optional[dict]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM winrate_cache WHERE ticker=? AND signal=? AND "
                "as_of_date=? AND horizon_days=? AND lookback_years=?",
                (ticker, signal, as_of_date, horizon_days, lookback_years),
            ).fetchone()
            return dict(row) if row else None

    def cache_winrate(
        self, *, ticker: str, signal: str, as_of_date: str,
        horizon_days: int, lookback_years: int,
        hit_rate: Optional[float], n_occurrences: int,
        avg_forward_return: Optional[float],
    ) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO winrate_cache (ticker, signal, "
                "as_of_date, horizon_days, lookback_years, hit_rate, "
                "n_occurrences, avg_forward_return) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (ticker, signal, as_of_date, horizon_days, lookback_years,
                 hit_rate, n_occurrences, avg_forward_return),
            )

    # --- conversation log ----------------------------------------------------

    def record_message(
        self, *, channel: str, role: str, content: str,
        session_id: Optional[str] = None, ticker: Optional[str] = None,
    ) -> int:
        """Append one chat turn to the conversation log. Returns its row id."""
        with self._conn() as conn:
            cur = conn.execute(
                "INSERT INTO conversations (channel, session_id, role, ticker, "
                "content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (channel, session_id, role,
                 (ticker or None) and ticker.upper(), content, self._now()),
            )
            return int(cur.lastrowid)

    def recent_messages(
        self, *, session_id: Optional[str] = None,
        channel: Optional[str] = None, limit: int = 20,
    ) -> List[dict]:
        """Most recent turns (oldest→newest), optionally scoped to a session/channel."""
        clauses, params = [], []
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if channel:
            clauses.append("channel = ?")
            params.append(channel)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        params.append(int(limit))
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT channel, session_id, role, ticker, content, created_at "
                "FROM conversations" + where +
                " ORDER BY id DESC LIMIT ?", params,
            ).fetchall()
        return [dict(r) for r in reversed(rows)]

    def search_messages(self, query: str, limit: int = 20) -> List[dict]:
        """Full-text-ish search of the conversation log (substring match)."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT channel, session_id, role, ticker, content, created_at "
                "FROM conversations WHERE content LIKE ? "
                "ORDER BY id DESC LIMIT ?",
                (f"%{query}%", int(limit)),
            ).fetchall()
        return [dict(r) for r in rows]

    def conversation_sessions(self, channel: Optional[str] = None, limit: int = 30) -> List[dict]:
        """Distinct sessions with their turn count and last-activity timestamp."""
        clause = " WHERE channel = ?" if channel else ""
        params = ([channel] if channel else []) + [int(limit)]
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT session_id, channel, COUNT(*) AS turns, "
                "MAX(created_at) AS last_at, MAX(ticker) AS ticker "
                "FROM conversations" + clause +
                " GROUP BY session_id, channel ORDER BY last_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [dict(r) for r in rows]


def _to_text(value) -> Optional[str]:
    """Coerce a scoreboard raw_value to text (it may be a number or a label)."""
    if value is None:
        return None
    return str(value)
