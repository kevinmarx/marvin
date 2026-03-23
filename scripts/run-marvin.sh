#!/usr/bin/env bash
# Marvin — launch the long-running orchestrator with auto-restart
# Uses minimal plugins to keep teammate spawn commands within tmux limits
#
# The orchestrator self-restarts after N cycles (default 24) to compact context.
# This wrapper detects clean self-restarts vs crashes and restarts accordingly.
#
# Usage: ./scripts/run-marvin.sh
# Stop:  ./scripts/stop-marvin.sh  (from another terminal)
#
# Environment variables (for remote deployment):
#   MARVIN_CONFIG       — path to config JSON (default: reads from config/default.json)
#   MARVIN_PLUGINS_DIR  — path to plugins directory (default: ./plugins in project root)
#   MARVIN_REMOTE       — set to "1" to skip local dashboard launch (entrypoint handles it)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Ensure PATH includes locations that non-interactive shells (cron, nohup) miss
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Support remote plugin paths (default: plugins/ in project root)
PLUGINS_DIR="${MARVIN_PLUGINS_DIR:-$PROJECT_DIR/plugins}"
PLUGINS=(
  "--plugin-dir" "$PLUGINS_DIR/linear-mcp/"
  "--plugin-dir" "$PLUGINS_DIR/local-memory-mcp/"
)

cd "$PROJECT_DIR"

# Ensure LiteLLM proxy env vars are set (needed for claude CLI and all spawned teammates)
# These may already be set via ~/.zshrc but bash scripts don't source zshrc
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://localhost:4000}"
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-}"
export ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-claude-opus-4*}"

# Resolve DB path from config (if MARVIN_CONFIG is set, extract state_db; otherwise use default)
if [ -n "${MARVIN_CONFIG:-}" ] && [ -f "$MARVIN_CONFIG" ]; then
  DB_PATH=$(python3 -c "import json; print(json.load(open('$MARVIN_CONFIG')).get('state_db', '$HOME/.marvin/state/marvin.db'))")
else
  DB_PATH="$HOME/.marvin/state/marvin.db"
fi

# Ensure DB directory exists
mkdir -p "$(dirname "$DB_PATH")"

# Ensure DB exists
if [ ! -f "$DB_PATH" ]; then
  "$SCRIPT_DIR/setup.sh"
fi

# Start dashboard in background (skip if MARVIN_REMOTE — entrypoint handles it)
if [ "${MARVIN_REMOTE:-}" != "1" ]; then
  python3 "$SCRIPT_DIR/dashboard.py" > /dev/null 2>&1 &
fi

echo "Starting Marvin orchestrator (with auto-restart)..."
echo "  Project: $PROJECT_DIR"
echo "  Config: ${MARVIN_CONFIG:-config/default.json}"
echo "  DB: $DB_PATH"
echo "  Dashboard: http://localhost:7777"
echo "  Stop: ./scripts/stop-marvin.sh"
echo ""

while true; do
  echo "$(date) — Starting orchestrator session..."

  # Run mechanical housekeeping scripts (no agent needed, 60s timeout to prevent blocking)
  timeout 60 "$SCRIPT_DIR/pr-age-labels.sh" "${MARVIN_CONFIG:-}" 2>/dev/null || true

  # Unset to allow spawning claude from within another Claude Code session (e.g. watchdog cron)
  unset CLAUDECODE

  claude --dangerously-skip-permissions \
    "${PLUGINS[@]}" \
    -p "Run /marvin-cycle"

  EXIT_CODE=$?

  # Check if clean self-restart vs crash
  CLEAN=$(sqlite3 "$DB_PATH" \
    "SELECT current_step FROM heartbeat WHERE id = 1;" 2>/dev/null)

  if [ "$CLEAN" = "self_restart" ]; then
    echo "$(date) — Clean self-restart, resuming in 5s..."
    sleep 5
  else
    echo "$(date) — Unexpected exit (code=$EXIT_CODE, step=$CLEAN), restarting in 30s..."
    sleep 30
  fi
done
