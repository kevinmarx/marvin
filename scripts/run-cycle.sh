#!/usr/bin/env bash
# Marvin — run one triage cycle
# Invokes claude CLI with the /marvin-cycle command

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOCK_FILE="$HOME/.marvin/cycle.lock"
LOG_DIR="$HOME/.marvin/logs"
LOG_FILE="$LOG_DIR/cycle-$(date +%Y%m%d-%H%M%S).log"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Lock file check (30-min staleness)
if [ -f "$LOCK_FILE" ]; then
  lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || stat -c %Y "$LOCK_FILE" 2>/dev/null) ))
  if [ "$lock_age" -lt 1800 ]; then
    echo "Another cycle is running (lock file is ${lock_age}s old). Exiting."
    exit 0
  else
    echo "Stale lock file detected (${lock_age}s old). Removing."
    rm -f "$LOCK_FILE"
  fi
fi

# Create lock file
trap 'rm -f "$LOCK_FILE"' EXIT
touch "$LOCK_FILE"

echo "=== Marvin Cycle — $(date) ===" | tee "$LOG_FILE"

# Ensure DB exists
DB_PATH="$HOME/.marvin/state/marvin.db"
if [ ! -f "$DB_PATH" ]; then
  echo "Database not found. Running setup first..." | tee -a "$LOG_FILE"
  "$SCRIPT_DIR/setup.sh" 2>&1 | tee -a "$LOG_FILE"
fi

# Run the cycle via claude CLI
claude --dangerously-skip-permissions \
  -p "Run /marvin-cycle" \
  --cwd "$PROJECT_DIR" \
  2>&1 | tee -a "$LOG_FILE"

echo "=== Cycle complete — $(date) ===" | tee -a "$LOG_FILE"
