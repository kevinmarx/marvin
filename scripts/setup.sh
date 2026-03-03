#!/usr/bin/env bash
# Marvin — first-time setup
# Creates state directory and initializes SQLite database via migrations

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$HOME/.marvin/state"
LOG_DIR="$HOME/.marvin/logs"
BACKUP_DIR="$HOME/.marvin/backups"
DB_PATH="$STATE_DIR/marvin.db"

echo "=== Marvin Setup ==="

# Create directories
echo "Creating directories..."
mkdir -p "$STATE_DIR" "$LOG_DIR" "$BACKUP_DIR"

# Run migrations (creates DB if needed, applies all schema)
echo ""
echo "Running migrations..."
"$SCRIPT_DIR/migrate.sh"

# Verify database
echo ""
echo "Verifying database..."
sqlite3 "$DB_PATH" ".tables"

SCHEMA_VERSION=$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(version), 0) FROM schema_version;")
echo "Schema version: $SCHEMA_VERSION"

echo ""
echo "=== Setup Complete ==="
echo "State DB: $DB_PATH"
echo "Logs: $LOG_DIR"
echo "Backups: $BACKUP_DIR"
echo ""
echo "Next steps:"
echo "  1. Run a triage cycle: ./scripts/run-cycle.sh"
echo "  2. Run a digest:       ./scripts/run-digest.sh"
