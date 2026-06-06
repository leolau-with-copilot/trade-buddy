"""Invitation-code access gate for the webapp.

Two static codes (configurable via env) grant access at two tiers:

* **guest**   (default code ``trade buddy``)        — the visitor must supply
  their *own* DeepSeek + Alpaca-paper keys; those keys live encrypted inside the
  visitor's session cookie and never touch server storage.
* **invited** (default code ``trade buddy is good``) — uses the owner's keys
  from the server environment (``DEEPSEEK_API_KEY`` / ``ALPACA_*``).

The session is a single Fernet-encrypted cookie (``tb_session``) carrying the
tier and, for guests, their keys. Because it rides on the cookie it is sent with
every request — fetch *and* EventSource (SSE) — so no per-request header plumbing
is needed and there is no server-side session store to sync.

Market-data vendors (yfinance, Finnhub, FRED, …) always use the server's own
keys regardless of tier; only the LLM (DeepSeek) and the brokerage (Alpaca) are
user-supplied for guests.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from tradingagents.default_config import DEFAULT_CONFIG

logger = logging.getLogger(__name__)

# --- codes ----------------------------------------------------------------- #
# Normalised (lowercased, whitespace-collapsed) so "Trade  Buddy" still matches.
_GUEST_CODE = os.environ.get("TB_GUEST_CODE", "trade buddy")
_INVITED_CODE = os.environ.get("TB_INVITED_CODE", "trade buddy is good")

COOKIE_NAME = "tb_session"
_MAX_AGE = 30 * 24 * 3600  # 30 days


def _norm(code: str) -> str:
    return " ".join((code or "").strip().lower().split())


def tier_for_code(code: str) -> Optional[str]:
    """Return ``"guest"`` / ``"invited"`` for a valid code, else ``None``."""
    c = _norm(code)
    if c and c == _norm(_INVITED_CODE):
        return "invited"
    if c and c == _norm(_GUEST_CODE):
        return "guest"
    return None


# --- secret + cipher ------------------------------------------------------- #
def _load_secret() -> bytes:
    """A stable signing secret: env first, else a generated file under the cache.

    Persisting it means sessions survive restarts; generating it means the app
    works out of the box without configuration. Set ``TB_SESSION_SECRET`` in
    production so the secret is yours and not on disk in the cache dir.
    """
    env = os.environ.get("TB_SESSION_SECRET")
    if env:
        return env.encode()
    path = Path(DEFAULT_CONFIG["data_cache_dir"]) / ".tb_session_secret"
    try:
        if path.exists():
            return path.read_bytes()
        path.parent.mkdir(parents=True, exist_ok=True)
        secret = secrets.token_bytes(32)
        path.write_bytes(secret)
        os.chmod(path, 0o600)
        return secret
    except OSError as exc:  # pragma: no cover - fall back to an ephemeral secret
        logger.warning("could not persist session secret (%s); using ephemeral", exc)
        return secrets.token_bytes(32)


_FERNET = Fernet(base64.urlsafe_b64encode(hashlib.sha256(_load_secret()).digest()))


# --- session model --------------------------------------------------------- #
@dataclass
class Session:
    tier: str                              # "guest" | "invited"
    deepseek_key: str = ""                 # guest-supplied (empty for invited)
    alpaca_key: str = ""
    alpaca_secret: str = ""

    @property
    def is_invited(self) -> bool:
        return self.tier == "invited"

    def llm_api_key(self) -> Optional[str]:
        """The DeepSeek key to use, or ``None`` to fall back to the server env."""
        return self.deepseek_key or None

    def alpaca_keys(self) -> Optional[tuple[str, str]]:
        """The (key, secret) pair to use, or ``None`` to fall back to the env."""
        if self.alpaca_key and self.alpaca_secret:
            return self.alpaca_key, self.alpaca_secret
        return None


def encode_session(sess: Session) -> str:
    payload = {
        "tier": sess.tier,
        "ds": sess.deepseek_key,
        "ak": sess.alpaca_key,
        "as": sess.alpaca_secret,
        "iat": int(time.time()),
    }
    return _FERNET.encrypt(json.dumps(payload).encode()).decode()


def decode_session(token: str) -> Optional[Session]:
    if not token:
        return None
    try:
        raw = _FERNET.decrypt(token.encode(), ttl=_MAX_AGE)
        data = json.loads(raw)
    except (InvalidToken, ValueError, TypeError):
        return None
    tier = data.get("tier")
    if tier not in ("guest", "invited"):
        return None
    return Session(
        tier=tier,
        deepseek_key=data.get("ds", "") or "",
        alpaca_key=data.get("ak", "") or "",
        alpaca_secret=data.get("as", "") or "",
    )
