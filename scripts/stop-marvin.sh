#!/usr/bin/env bash
# Marvin — kill all marvin processes (wrapper loop, orchestrator, teammates, dashboard)
#
# IMPORTANT: This script must NOT kill interactive Claude Code sessions.
# It identifies Marvin processes by the "-p Run /marvin-cycle" argument
# which is unique to the orchestrator, and by parent PID lineage for
# teammates (which are children of the orchestrator).

echo "Killing Marvin processes..."

# Kill the run-marvin.sh wrapper loop first (prevents auto-restart)
pkill -f "run-marvin.sh" 2>/dev/null || true

# Find and kill Marvin orchestrator processes specifically.
# Marvin orchestrators are launched with "-p Run /marvin-cycle" which no
# interactive session would have. This is much safer than matching on
# plugin names which interactive sessions also load.
MARVIN_PIDS=$(pgrep -f "marvin-cycle" 2>/dev/null || true)
for pid in $MARVIN_PIDS; do
  # Don't kill this script
  [ "$pid" = "$$" ] && continue
  # Kill the process tree (orchestrator + its teammate children)
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
done

# Kill dashboard
lsof -ti :7777 2>/dev/null | xargs kill 2>/dev/null || true

# Kill any orphaned marvin-specific shell commands.
# These patterns are specific enough to not match interactive sessions
# (an interactive session in the marvin directory won't have these as
# part of its process command line).
for pattern in "marvin-phase" "marvin-execute" "marvin-review" \
               "marvin-ci-fix" "marvin-audit" "marvin-docs" "marvin-digest" \
               "marvin-reassign" "run-marvin.sh" "backup-db.sh"; do
  pgrep -f "$pattern" | while read pid; do
    # Don't kill this script
    [ "$pid" = "$$" ] && continue
    kill "$pid" 2>/dev/null || true
  done
done

sleep 1

# Force kill stragglers — only target marvin-cycle processes, not broad claude patterns
pkill -9 -f "run-marvin.sh" 2>/dev/null || true
for pid in $MARVIN_PIDS; do
  kill -9 "$pid" 2>/dev/null || true
done
lsof -ti :7777 2>/dev/null | xargs kill -9 2>/dev/null || true

echo "Marvin stopped."
