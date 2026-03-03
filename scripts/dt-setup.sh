#!/usr/bin/env bash
# Deep Thought — First-time setup
# Creates state directories and runs migrations

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🧠 Deep Thought — Setup"
echo "========================"

# Create state directories
echo "Creating directories..."
mkdir -p "$HOME/.deep-thought/state"
mkdir -p "$HOME/.deep-thought/logs"
mkdir -p "$HOME/.deep-thought/backups"

# Run migrations
echo ""
echo "Running migrations..."
bash "$SCRIPT_DIR/dt-migrate.sh"

echo ""
echo "✅ Deep Thought setup complete"
echo "   DB: ~/.deep-thought/state/deep-thought.db"
echo "   Logs: ~/.deep-thought/logs/"
echo "   Backups: ~/.deep-thought/backups/"
echo ""
echo "Next: run scripts/run-deep-thought.sh to start"
