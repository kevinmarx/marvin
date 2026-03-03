#!/usr/bin/env bash
# Marvin — Database migration runner
# Applies numbered SQL migrations in order, tracking which have been applied

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MIGRATIONS_DIR="$PROJECT_DIR/schema/migrations"
STATE_DIR="$HOME/.marvin/state"
DB_PATH="$STATE_DIR/marvin.db"

# Create directories if needed
mkdir -p "$STATE_DIR"

# Ensure schema_version table exists (bootstrap)
sqlite3 "$DB_PATH" "CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);"

# Get current version
CURRENT_VERSION=$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(version), 0) FROM schema_version;")
echo "Current schema version: $CURRENT_VERSION"

# Find and apply pending migrations
APPLIED=0
for migration in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$migration" ] || continue

  # Extract version number from filename (e.g., 001_initial.sql -> 1)
  filename=$(basename "$migration")
  version=$(echo "$filename" | sed 's/^0*//' | cut -d'_' -f1)

  if [ "$version" -le "$CURRENT_VERSION" ]; then
    continue
  fi

  echo "Applying migration $filename..."

  # Apply migration within a transaction
  if sqlite3 "$DB_PATH" < "$migration"; then
    # Record the migration
    sqlite3 "$DB_PATH" "INSERT INTO schema_version (version) VALUES ($version);"
    echo "  Applied migration $filename"
    APPLIED=$((APPLIED + 1))
  else
    echo "ERROR: Migration $filename failed!"
    exit 1
  fi
done

if [ "$APPLIED" -eq 0 ]; then
  echo "Database is up to date (version $CURRENT_VERSION)"
else
  NEW_VERSION=$(sqlite3 "$DB_PATH" "SELECT MAX(version) FROM schema_version;")
  echo "Applied $APPLIED migration(s). Now at version $NEW_VERSION"
fi
