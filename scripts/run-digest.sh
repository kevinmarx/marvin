#!/usr/bin/env bash
# Marvin — run digest
# Invokes claude CLI with the /marvin-digest command

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$HOME/.marvin/logs"
LOG_FILE="$LOG_DIR/digest-$(date +%Y%m%d-%H%M%S).log"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

echo "=== Marvin Digest — $(date) ===" | tee "$LOG_FILE"

# Ensure DB exists
DB_PATH="$HOME/.marvin/state/marvin.db"
if [ ! -f "$DB_PATH" ]; then
  echo "Database not found. Running setup first..." | tee -a "$LOG_FILE"
  "$SCRIPT_DIR/setup.sh" 2>&1 | tee -a "$LOG_FILE"
fi

# Run the digest via claude CLI
claude --dangerously-skip-permissions \
  -p "Run /marvin-digest" \
  --cwd "$PROJECT_DIR" \
  2>&1 | tee -a "$LOG_FILE"

echo "=== Digest complete — $(date) ===" | tee -a "$LOG_FILE"
