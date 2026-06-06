"""Run a user-authored Python strategy against historical data, safely.

Untrusted code is never executed in the server process. Instead we:

1. Fetch OHLCV here (trusted) and write it + the user's code to a temp dir.
2. Launch :mod:`webapp._sandbox_runner` in a child process with **defense in
   depth**:
   * a **clean environment** — none of the server's secrets (DEEPSEEK/ALPACA
     keys, etc.) are passed, so user code can't read them via ``os.environ``;
   * **resource limits** (CPU seconds, address space, file size, no new procs)
     via ``setrlimit`` so a strategy can't exhaust the box;
   * a **wall-clock timeout**;
   * a private temp **cwd**.
3. When **bubblewrap** (``bwrap``) is available we additionally jail the child
   with ``--unshare-all`` (no network) and bind only the read-only system +
   interpreter + the temp dir, so the code **cannot read the filesystem**
   (e.g. ``/opt/trade-buddy/.env``). Without bwrap, filesystem/network isolation
   is NOT enforced — set ``BACKTEST_REQUIRE_SANDBOX=1`` to refuse to run in that
   case. Install bubblewrap on the server (``dnf install -y bubblewrap``).

Returns the runner's JSON: ``{ok, metrics, equity_curve, trades}`` or
``{ok: false, error, trace}``.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import shutil
import subprocess
import sys
import sysconfig
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

import yfinance as yf

logger = logging.getLogger(__name__)

_RUNNER = str(Path(__file__).parent / "_sandbox_runner.py")
_CPU_SECONDS = int(os.environ.get("BACKTEST_CPU_SECONDS", "15"))
# Default 2GB virtual-address cap. RLIMIT_AS bounds *virtual* memory, and
# numpy/pandas reserve a lot of it at import — too low (e.g. 512MB) kills the
# child before it can run. 0/empty disables the cap entirely.
_MEM_MB = int(os.environ.get("BACKTEST_MEM_MB", "2048"))
_WALL_TIMEOUT = int(os.environ.get("BACKTEST_WALL_SECONDS", "25"))
_MAX_CODE = 20000  # chars
# Max lookback (days) yfinance serves per intraday interval. Daily/weekly are
# unlimited and intentionally absent. Used to clamp the backtest start.
_INTRADAY_MAX_DAYS = {"1m": 7, "5m": 59, "15m": 59, "30m": 59, "1h": 729}
_REQUIRE_SANDBOX = os.environ.get("BACKTEST_REQUIRE_SANDBOX", "") not in ("", "0", "false")


def _rlimits() -> None:  # pragma: no cover - runs in the child
    """preexec_fn: cap CPU, file size, subprocess count, and (Linux) memory."""
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (_CPU_SECONDS, _CPU_SECONDS))
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
        # RLIMIT_AS is unreliable on macOS (breaks numpy/pandas import); only
        # apply it on Linux, and only if a positive cap is configured.
        if _MEM_MB > 0 and sys.platform.startswith("linux"):
            try:
                resource.setrlimit(resource.RLIMIT_AS, (_MEM_MB * 1024 * 1024,) * 2)
            except (ValueError, OSError):
                pass
        try:
            resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        except (ValueError, OSError):
            pass
    except Exception:  # noqa: BLE001
        pass


def _bwrap_prefix(tmpdir: str) -> Optional[list]:
    """A bubblewrap argv prefix that jails the child (FS + network), or None.

    Binds a minimal read-only system (so secrets like .env stay out of reach),
    a writable temp dir, and drops the network with ``--unshare-net``. We avoid
    ``--unshare-all`` because its user-namespace requirement is disabled on some
    kernels. Bind paths are de-duplicated so nested paths don't double-mount.
    """
    bwrap = shutil.which("bwrap")
    if not bwrap:
        return None
    binds = ["/usr"]
    links = []
    # On merged-/usr systems /bin, /lib, /lib64 are symlinks into /usr. The
    # symlinks must be RECREATED in the jail (not skipped) or the kernel can't
    # find the dynamic loader (/lib64/ld-linux…) and no binary will launch.
    for p in ("/bin", "/sbin", "/lib", "/lib64"):
        if os.path.islink(p):
            links += ["--symlink", os.readlink(p), p]
        elif os.path.isdir(p):
            binds.append(p)
    if os.path.isdir("/etc/alternatives"):
        binds.append("/etc/alternatives")
    # Make the venv tree and the real interpreter's prefix visible.
    real_py_prefix = os.path.dirname(os.path.dirname(os.path.realpath(sys.executable)))
    for p in (os.path.realpath(sys.prefix), real_py_prefix):
        if not any(p == b or p.startswith(b + "/") for b in binds):
            binds.append(p)
    args = [bwrap, "--unshare-net", "--die-with-parent", "--new-session",
            "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    for b in binds:
        args += ["--ro-bind", b, b]
    if os.path.exists("/etc/ld.so.cache"):          # help the dynamic linker
        args += ["--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"]
    args += ["--ro-bind", _RUNNER, _RUNNER]          # the runner script itself
    args += links
    args += ["--bind", tmpdir, tmpdir, "--chdir", tmpdir]
    return args


def run_backtest(
    code: str,
    ticker: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    *,
    cash: float = 10000.0,
    interval: str = "1d",
) -> Dict[str, Any]:
    """Backtest ``code``'s ``generate_signals(data)`` on ``ticker`` over a range."""
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"ok": False, "error": "Provide a ticker."}
    if not code or not code.strip():
        return {"ok": False, "error": "Write a strategy (define generate_signals(data))."}
    if len(code) > _MAX_CODE:
        return {"ok": False, "error": f"Strategy too long (>{_MAX_CODE} chars)."}

    end = end or dt.date.today().isoformat()
    # Default span: ~1 month for intraday, 2 years for daily.
    default_days = 30 if interval in _INTRADAY_MAX_DAYS else 365 * 2
    start = start or (dt.date.fromisoformat(end) - dt.timedelta(days=default_days)).isoformat()
    # yfinance caps intraday history (1m≈7d, 5/15/30m≈60d, 1h≈730d). Clamp the
    # start so an intraday backtest doesn't silently come back empty.
    cap = _INTRADAY_MAX_DAYS.get(interval)
    if cap:
        floor = (dt.date.fromisoformat(end) - dt.timedelta(days=cap)).isoformat()
        if start < floor:
            start = floor

    # 1. Fetch data (trusted, in-process).
    try:
        hist = yf.Ticker(sym).history(start=start, end=end, interval=interval)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"Could not fetch data for {sym}: {exc}"}
    if hist is None or hist.empty or len(hist) < 5:
        return {"ok": False, "error": f"Not enough price history for {sym} in that range."}
    df = hist.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].copy()
    if getattr(df.index, "tz", None) is not None:
        df.index = df.index.tz_localize(None)   # tz-naive so the CSV round-trip stays datetime
    df.index.name = "date"

    bwrap = _bwrap_prefix("")  # presence check only
    if bwrap is None and _REQUIRE_SANDBOX:
        return {"ok": False, "error": "Sandbox (bubblewrap) is required but not installed on the server."}

    # 2. Stage inputs in a private temp dir.
    tmp = tempfile.mkdtemp(prefix="bt_")
    try:
        data_csv = os.path.join(tmp, "data.csv")
        code_path = os.path.join(tmp, "strategy.py")
        out_path = os.path.join(tmp, "out.json")
        params_path = os.path.join(tmp, "params.json")
        df.to_csv(data_csv)
        Path(code_path).write_text(code, encoding="utf-8")
        Path(params_path).write_text(json.dumps({"cash": cash}), encoding="utf-8")

        run_args = [_RUNNER, data_csv, code_path, out_path, params_path]
        prefix = _bwrap_prefix(tmp)
        env_extra = {}
        if prefix is None:
            logger.warning("bubblewrap not found — running backtest without FS/network isolation")
            cmd = [sys.executable, "-I", *run_args]   # venv python directly (no jail)
        else:
            # In the jail, run the *real* interpreter (symlinks resolved) and put
            # the venv's packages on PYTHONPATH so numpy/pandas import cleanly.
            cmd = prefix + [os.path.realpath(sys.executable), *run_args]
            env_extra["PYTHONPATH"] = sysconfig.get_path("purelib")

        # 3. Execute with a clean env + resource limits + wall-clock timeout.
        clean_env = {"PATH": "/usr/bin:/bin", "HOME": tmp,
                     "PYTHONDONTWRITEBYTECODE": "1", **env_extra}
        try:
            proc = subprocess.run(
                cmd, cwd=tmp, env=clean_env, timeout=_WALL_TIMEOUT,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                preexec_fn=_rlimits if os.name == "posix" else None,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"Backtest timed out (> {_WALL_TIMEOUT}s)."}

        if not os.path.exists(out_path):
            err = (proc.stderr or b"").decode("utf-8", "replace").strip()[-900:]
            detail = f" (exit {proc.returncode})"
            return {"ok": False,
                    "error": "Strategy crashed before producing output" + detail + ".",
                    "trace": err or "(no stderr captured)"}
        result = json.loads(Path(out_path).read_text(encoding="utf-8"))
        result["ticker"] = sym
        result["start"] = start
        result["end"] = end
        result["interval"] = interval
        return result
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
