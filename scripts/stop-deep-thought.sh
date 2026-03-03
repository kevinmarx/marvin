#!/usr/bin/env bash
# Deep Thought — kill all deep-thought processes (wrapper loop, orchestrator, scanners, dashboard)
#
# IMPORTANT: This script must NOT kill interactive Claude Code sessions.
# It identifies Deep Thought by the "dt-cycle" argument in process args
# (unique to the orchestrator) and kills its child tree.

echo "Killing Deep Thought processes..."

# Kill the run-deep-thought.sh wrapper loop first (prevents auto-restart)
pkill -f "run-deep-thought.sh" 2>/dev/null || true

# Find and kill Deep Thought orchestrator processes specifically.
# Deep Thought orchestrators are launched with "dt-cycle" which no
# interactive session would have as a process argument.
DT_PIDS=$(pgrep -f "dt-cycle" 2>/dev/null || true)
for pid in $DT_PIDS; do
  # Don't kill this script
  [ "$pid" = "$$" ] && continue
  # Kill the process tree (orchestrator + its scanner children)
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
done

# Kill dashboard on port 7778
lsof -ti :7778 2>/dev/null | xargs kill 2>/dev/null || true

# Kill any orphaned deep-thought-specific shell commands.
for pattern in "dt-phase" "dt-scan" "run-deep-thought.sh"; do
  pgrep -f "$pattern" | while read pid; do
    # Don't kill this script
    [ "$pid" = "$$" ] && continue
    kill "$pid" 2>/dev/null || true
  done
done

sleep 1

# Force kill stragglers — only target specific DT processes
pkill -9 -f "run-deep-thought.sh" 2>/dev/null || true
for pid in $DT_PIDS; do
  kill -9 "$pid" 2>/dev/null || true
done
lsof -ti :7778 2>/dev/null | xargs kill -9 2>/dev/null || true

echo "Deep Thought stopped."
