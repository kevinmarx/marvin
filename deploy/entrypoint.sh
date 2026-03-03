#!/usr/bin/env bash
set -euo pipefail

echo "=== Marvin entrypoint starting ==="

# ── First-run: initialize state volume ───────────────────────────────────────
if [ ! -f /data/state/marvin.db ]; then
  echo "First run — initializing state volume..."
  mkdir -p /data/state /data/state/logs /data/state/backups
  /home/marvin/marvin/scripts/setup.sh
fi

# ── Always run migrations (idempotent) ───────────────────────────────────────
echo "Running migrations..."
/home/marvin/marvin/scripts/migrate.sh

# ── First-run: clone repos (read from config) ───────────────────────────────
CONFIG="${MARVIN_CONFIG:-/home/marvin/marvin/config/remote.json}"
GITHUB_ORG=$(python3 -c "import json; print(json.load(open('$CONFIG')).get('github_org', 'your-org'))")

for REPO_NAME in $(python3 -c "import json; [print(r) for r in json.load(open('$CONFIG')).get('repos', {}).keys()]"); do
  if [ ! -d "/data/repos/$REPO_NAME" ]; then
    echo "Cloning $REPO_NAME..."
    git clone "https://github.com/$GITHUB_ORG/$REPO_NAME.git" "/data/repos/$REPO_NAME"
  fi
done
mkdir -p /data/repos/worktrees

# ── Configure git (read from config or env) ──────────────────────────────────
GIT_NAME="${MARVIN_GIT_NAME:-$(python3 -c "import json; print(json.load(open('$CONFIG')).get('git_name', 'Marvin Bot'))")}"
GIT_EMAIL="${MARVIN_GIT_EMAIL:-$(python3 -c "import json; print(json.load(open('$CONFIG')).get('git_email', 'marvin@example.com'))")}"
git config --global user.name "$GIT_NAME" 2>/dev/null || true
git config --global user.email "$GIT_EMAIL" 2>/dev/null || true

# ── Start dashboard (background) ────────────────────────────────────────────
echo "Starting dashboard..."
MARVIN_REMOTE=1 python3 /home/marvin/marvin/scripts/dashboard.py &

# ── Orchestrator (foreground — container lifecycle tied to this) ─────────────
echo "Starting Marvin orchestrator..."
exec /home/marvin/marvin/scripts/run-marvin.sh
