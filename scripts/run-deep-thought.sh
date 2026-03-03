#!/usr/bin/env bash
# Deep Thought — launch the long-running orchestrator with auto-restart
# Uses minimal plugins (linear-mcp, local-memory-mcp, datadog-mcp) for observability analysis
#
# The orchestrator self-restarts after N cycles (default 4, ~24 hours) to compact context.
# This wrapper detects clean self-restarts vs crashes and restarts accordingly.
#
# Usage: ./scripts/run-deep-thought.sh
# Stop:  ./scripts/stop-deep-thought.sh  (from another terminal)
#
# Environment variables:
#   DEEP_THOUGHT_CONFIG       — path to config JSON (default: config/deep-thought.json)
#   DEEP_THOUGHT_PLUGINS_DIR  — path to plugins directory (default: ./plugins in project root)
#   DEEP_THOUGHT_REMOTE       — set to "1" to skip local dashboard launch

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Support remote plugin paths (default: plugins/ in project root)
PLUGINS_DIR="${DEEP_THOUGHT_PLUGINS_DIR:-$PROJECT_DIR/plugins}"
PLUGINS=(
  "--plugin-dir" "$PLUGINS_DIR/linear-mcp/"
  "--plugin-dir" "$PLUGINS_DIR/local-memory-mcp/"
)

# Add datadog-mcp if available
if [ -d "$PLUGINS_DIR/datadog-mcp/" ]; then
  PLUGINS+=("--plugin-dir" "$PLUGINS_DIR/datadog-mcp/")
fi

cd "$PROJECT_DIR"

# Ensure LiteLLM proxy env vars are set (needed for claude CLI and all spawned teammates)
# These may already be set via ~/.zshrc but bash scripts don't source zshrc
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://localhost:4000}"
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-}"
export ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-claude-opus-4*}"

# Resolve DB path from config
CONFIG_PATH="${DEEP_THOUGHT_CONFIG:-$PROJECT_DIR/config/deep-thought.json}"
if [ -f "$CONFIG_PATH" ]; then
  DB_PATH=$(python3 -c "
import json, os
config = json.load(open('$CONFIG_PATH'))
db = config.get('state_db', '~/.deep-thought/state/deep-thought.db')
print(os.path.expanduser(db))
")
else
  DB_PATH="$HOME/.deep-thought/state/deep-thought.db"
fi

# Ensure DB directory exists
mkdir -p "$(dirname "$DB_PATH")"

# Ensure DB exists
if [ ! -f "$DB_PATH" ]; then
  "$SCRIPT_DIR/dt-setup.sh"
fi

# Start dashboard in background (skip if DEEP_THOUGHT_REMOTE — entrypoint handles it)
if [ "${DEEP_THOUGHT_REMOTE:-}" != "1" ]; then
  python3 "$SCRIPT_DIR/dt-dashboard.py" > /dev/null 2>&1 &
fi

echo "Starting Deep Thought orchestrator (with auto-restart)..."
echo "  Project: $PROJECT_DIR"
echo "  Config: $CONFIG_PATH"
echo "  DB: $DB_PATH"
echo "  Dashboard: http://localhost:7778"
echo "  Stop: ./scripts/stop-deep-thought.sh"
echo ""

while true; do
  echo "$(date) — Starting orchestrator session..."

  claude --dangerously-skip-permissions \
    "${PLUGINS[@]}" \
    -p "Run /dt-cycle"

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
