#!/usr/bin/env bash
# Marvin — Worktree cleanup
# Removes worktrees for merged/closed PRs that have no active runs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${MARVIN_CONFIG:-$SCRIPT_DIR/../config/default.json}"

DB_PATH="$HOME/.marvin/state/marvin.db"
WORKTREE_ROOT=$(python3 -c "import json; print(json.load(open('$CONFIG'))['worktree_root'])")
# Use the first repo in config as the main repo for worktree management
MAIN_REPO_NAME=$(python3 -c "import json; print(list(json.load(open('$CONFIG'))['repos'].keys())[0])")
REPO_PATH=$(python3 -c "import json; print(list(json.load(open('$CONFIG'))['repos'].values())[0])")
GH_ORG=$(python3 -c "import json; print(json.load(open('$CONFIG'))['github_org'])")
DRY_RUN="${1:-}"

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "=== Dry Run Mode ==="
fi

echo "=== Marvin Worktree Cleanup ==="
echo ""

REMOVED=0
SKIPPED=0
ERRORS=0

# List all worktrees from the repo
for worktree_path in "$WORKTREE_ROOT"/*/; do
  [ -d "$worktree_path" ] || continue
  worktree_path="${worktree_path%/}"
  worktree_name=$(basename "$worktree_path")

  # Get the branch for this worktree
  branch=$(git -C "$worktree_path" branch --show-current 2>/dev/null || echo "")
  if [ -z "$branch" ]; then
    echo "SKIP: $worktree_name (detached HEAD or not a worktree)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Check if there are active runs referencing this worktree
  ACTIVE_TICKETS=$(sqlite3 "$DB_PATH" "
    SELECT COUNT(*) FROM tickets
    WHERE worktree_path = '$worktree_path'
      AND status IN ('executing', 'triaged');
  " 2>/dev/null || echo "0")

  ACTIVE_CI_FIX=$(sqlite3 "$DB_PATH" "
    SELECT COUNT(*) FROM ci_fix_runs
    WHERE status = 'running';
  " 2>/dev/null || echo "0")

  ACTIVE_REVIEWS=$(sqlite3 "$DB_PATH" "
    SELECT COUNT(*) FROM review_runs
    WHERE status = 'running';
  " 2>/dev/null || echo "0")

  if [ "$ACTIVE_TICKETS" -gt 0 ] || [ "$ACTIVE_CI_FIX" -gt 0 ] || [ "$ACTIVE_REVIEWS" -gt 0 ]; then
    echo "SKIP: $worktree_name (active runs: tickets=$ACTIVE_TICKETS ci_fix=$ACTIVE_CI_FIX reviews=$ACTIVE_REVIEWS)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Check if corresponding PR is merged or closed
  # Try to find PR by branch name
  PR_STATE=$(gh pr list --repo "$GH_ORG/$MAIN_REPO_NAME" --head "$branch" --state all \
    --json state -q '.[0].state' 2>/dev/null || echo "")

  if [ "$PR_STATE" = "MERGED" ] || [ "$PR_STATE" = "CLOSED" ]; then
    if [ "$DRY_RUN" = "--dry-run" ]; then
      echo "WOULD REMOVE: $worktree_name (branch: $branch, PR: $PR_STATE)"
    else
      echo "REMOVING: $worktree_name (branch: $branch, PR: $PR_STATE)"
      git -C "$REPO_PATH" worktree remove "$worktree_path" --force 2>/dev/null || {
        echo "  ERROR: Failed to remove $worktree_name"
        ERRORS=$((ERRORS + 1))
        continue
      }
    fi
    REMOVED=$((REMOVED + 1))
  elif [ -z "$PR_STATE" ]; then
    # No PR found — check if branch exists on remote
    REMOTE_EXISTS=$(git -C "$REPO_PATH" ls-remote --heads origin "$branch" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$REMOTE_EXISTS" -eq 0 ]; then
      if [ "$DRY_RUN" = "--dry-run" ]; then
        echo "WOULD REMOVE: $worktree_name (branch: $branch, no PR, no remote branch)"
      else
        echo "REMOVING: $worktree_name (branch: $branch, no PR, no remote branch)"
        git -C "$REPO_PATH" worktree remove "$worktree_path" --force 2>/dev/null || {
          echo "  ERROR: Failed to remove $worktree_name"
          ERRORS=$((ERRORS + 1))
          continue
        }
      fi
      REMOVED=$((REMOVED + 1))
    else
      echo "SKIP: $worktree_name (branch: $branch, no PR but remote branch exists)"
      SKIPPED=$((SKIPPED + 1))
    fi
  else
    echo "SKIP: $worktree_name (branch: $branch, PR state: $PR_STATE)"
    SKIPPED=$((SKIPPED + 1))
  fi
done

# Prune stale worktree references
if [ "$DRY_RUN" != "--dry-run" ]; then
  git -C "$REPO_PATH" worktree prune 2>/dev/null || true
fi

echo ""
echo "=== Summary ==="
echo "Removed: $REMOVED"
echo "Skipped: $SKIPPED"
echo "Errors:  $ERRORS"

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo ""
  echo "Run without --dry-run to actually remove worktrees"
fi
