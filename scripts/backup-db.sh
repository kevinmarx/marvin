#!/usr/bin/env bash
# Marvin — Database backup
# Creates a safe backup of the SQLite state database
# Keeps last 7 days of backups

set -euo pipefail

STATE_DIR="$HOME/.marvin/state"
BACKUP_DIR="$HOME/.marvin/backups"
DB_PATH="$STATE_DIR/marvin.db"
RETENTION_DAYS=7

if [ ! -f "$DB_PATH" ]; then
  echo "No database found at $DB_PATH"
  exit 1
fi

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Generate backup filename with timestamp
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
BACKUP_PATH="$BACKUP_DIR/marvin-$TIMESTAMP.db"

# Use SQLite's .backup command for a safe, consistent backup
# This works even if the database is being written to
sqlite3 "$DB_PATH" ".backup '$BACKUP_PATH'"

# Verify backup
if [ ! -f "$BACKUP_PATH" ]; then
  echo "ERROR: Backup failed — file not created"
  exit 1
fi

BACKUP_SIZE=$(du -h "$BACKUP_PATH" | awk '{print $1}')
echo "Backup created: $BACKUP_PATH ($BACKUP_SIZE)"

# Clean up old backups (keep last RETENTION_DAYS days)
find "$BACKUP_DIR" -name "marvin-*.db" -mtime +$RETENTION_DAYS -type f -print -delete

# Show current backups
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "marvin-*.db" -type f | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | awk '{print $1}')
echo "Total backups: $BACKUP_COUNT ($TOTAL_SIZE)"
