#!/usr/bin/env bash
# Marvin watchdog — runs via cron every 15 minutes.
# Checks the heartbeat table; if stale beyond threshold, kills and restarts Marvin.
#
# Install: crontab -e → */15 * * * * /Users/kemarx/workspace/km/marvin/scripts/watchdog.sh >> ~/.marvin/logs/watchdog.log 2>&1
#
# The watchdog will NOT restart if:
#   - The heartbeat is fresh (within threshold)
#   - run-marvin.sh isn't supposed to be running (no pidfile and no process)
#   - A restart was already attempted in the last 10 minutes (debounce)

set -euo pipefail

# Ensure PATH includes locations that cron doesn't inherit from the interactive shell
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Config
STALE_THRESHOLD_MINUTES=45
DEBOUNCE_MINUTES=10
DEBOUNCE_FILE="$HOME/.marvin/state/watchdog-last-restart"

# Resolve DB path
if [ -n "${MARVIN_CONFIG:-}" ] && [ -f "${MARVIN_CONFIG:-}" ]; then
  DB_PATH=$(python3 -c "import json; print(json.load(open('$MARVIN_CONFIG')).get('state_db', '$HOME/.marvin/state/marvin.db'))")
else
  DB_PATH="$HOME/.marvin/state/marvin.db"
fi

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') [watchdog] $*"
}

# Ensure log directory exists
mkdir -p "$HOME/.marvin/logs"

# Check if DB exists
if [ ! -f "$DB_PATH" ]; then
  log "DB not found at $DB_PATH — nothing to watch"
  exit 0
fi

# Get heartbeat age in minutes
LAST_BEAT=$(sqlite3 "$DB_PATH" "SELECT last_beat_at FROM heartbeat WHERE id = 1;" 2>/dev/null || echo "")
if [ -z "$LAST_BEAT" ]; then
  log "No heartbeat row found — Marvin may have never run"
  exit 0
fi

# Calculate age in minutes
# Heartbeat timestamps are UTC (ending in Z). Use python for reliable cross-platform UTC parsing.
BEAT_EPOCH=$(python3 -c "
from datetime import datetime, timezone
dt = datetime.strptime('$LAST_BEAT', '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
print(int(dt.timestamp()))
")
NOW_EPOCH=$(date "+%s")
AGE_MINUTES=$(( (NOW_EPOCH - BEAT_EPOCH) / 60 ))

# Check if healthy
if [ "$AGE_MINUTES" -lt "$STALE_THRESHOLD_MINUTES" ]; then
  log "Healthy — heartbeat age ${AGE_MINUTES}m (threshold ${STALE_THRESHOLD_MINUTES}m)"
  exit 0
fi

log "STALE — heartbeat age ${AGE_MINUTES}m (threshold ${STALE_THRESHOLD_MINUTES}m)"

# Check if Marvin is supposed to be running (any run-marvin.sh or claude marvin-cycle process)
MARVIN_RUNNING=$(pgrep -f "run-marvin.sh" 2>/dev/null || true)
CLAUDE_RUNNING=$(pgrep -f "marvin-cycle" 2>/dev/null || true)

if [ -z "$MARVIN_RUNNING" ] && [ -z "$CLAUDE_RUNNING" ]; then
  log "No Marvin processes found — not restarting (Marvin may be intentionally stopped)"
  exit 0
fi

# Debounce — don't restart if we already restarted recently
if [ -f "$DEBOUNCE_FILE" ]; then
  LAST_RESTART_EPOCH=$(cat "$DEBOUNCE_FILE")
  RESTART_AGE_MINUTES=$(( (NOW_EPOCH - LAST_RESTART_EPOCH) / 60 ))
  if [ "$RESTART_AGE_MINUTES" -lt "$DEBOUNCE_MINUTES" ]; then
    log "Debounce — last restart was ${RESTART_AGE_MINUTES}m ago (min ${DEBOUNCE_MINUTES}m), skipping"
    exit 0
  fi
fi

# Record restart attempt
echo "$NOW_EPOCH" > "$DEBOUNCE_FILE"

log "Restarting Marvin..."

# Stop everything
"$SCRIPT_DIR/stop-marvin.sh" 2>&1 | while read -r line; do log "  stop: $line"; done

sleep 3

# Start fresh (nohup + disown so cron doesn't wait)
cd "$PROJECT_DIR"
nohup "$SCRIPT_DIR/run-marvin.sh" >> "$HOME/.marvin/logs/marvin-stdout.log" 2>&1 &
disown

log "Marvin restarted (PID $!)"
