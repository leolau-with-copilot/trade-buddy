#!/usr/bin/env bash
#
# Push the TradingAgents app to a VPS over SSH with rsync.
#
# Usage:
#   scripts/deploy.sh user@VPS_IP                 # deploy to /opt/trade-buddy
#   scripts/deploy.sh user@VPS_IP /srv/app        # custom destination dir
#   DRY_RUN=1 scripts/deploy.sh user@VPS_IP       # preview what would transfer
#
# Notes:
#   * Copies your real .env over the encrypted SSH channel (NOT via GitHub), so
#     your API keys move securely. rsync ignores .gitignore on purpose here.
#   * Excludes caches, virtualenvs, node_modules, the 96M congress reference
#     folder, and the .git history — none of which the server needs to run.
#   * Re-run anytime; rsync only sends what changed.

set -euo pipefail

TARGET="${1:-}"
DEST="${2:-/opt/trade-buddy}"

if [[ -z "$TARGET" ]]; then
  echo "usage: $0 user@VPS_IP [dest_dir]" >&2
  exit 1
fi

# Resolve the repo root (this script lives in <root>/scripts/).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RSYNC_OPTS=(-avz --human-readable --delete)
[[ -n "${DRY_RUN:-}" ]] && RSYNC_OPTS+=(--dry-run)

EXCLUDES=(
  --exclude='.git'
  --exclude='__pycache__'
  --exclude='*.pyc'
  --exclude='.venv' --exclude='venv' --exclude='env'
  --exclude='node_modules'
  --exclude='congress-trading-monitor-main'
  --exclude='lean-master' --exclude='FinRL-master'   # heavy 3rd-party engines — never deploy
  --exclude='OpenBB-develop'                          # reference only — patterns ported, never deploy (too big)
  --exclude='.pytest_cache' --exclude='.mypy_cache' --exclude='.ruff_cache'
  --exclude='*.log'
  --exclude='.DS_Store'
  # NEVER overwrite the server's secrets — .env is managed on the server itself.
  # (Seed it once by hand on first deploy; re-deploys must leave it alone.)
  --exclude='.env' --exclude='.env.*'
)

echo ">> Deploying $ROOT  ->  $TARGET:$DEST"
[[ -n "${DRY_RUN:-}" ]] && echo ">> DRY RUN (no files will be written)"

# Make sure the destination exists on the remote.
ssh "$TARGET" "mkdir -p '$DEST'"

rsync "${RSYNC_OPTS[@]}" "${EXCLUDES[@]}" "$ROOT/" "$TARGET:$DEST/"

cat <<EOF

>> Files are on the VPS. Next, on the server:
   ssh $TARGET
   cd $DEST
   python3 -m venv .venv && . .venv/bin/activate
   pip install -e .
   #  add  CLAWBOT_API_TOKEN=...  to .env  (auth for the clawbot routes)
   TRADINGAGENTS_WEB_HOST=0.0.0.0 python3 -m webapp
EOF
