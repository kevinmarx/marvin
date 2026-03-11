# Branch safety check pattern

Never commit or push to `main`/`master`. Verify you're on a feature branch before ANY git write operation.

## Initial check (start of work)

Run this before doing any work in a worktree:

```bash
cd {worktree_path}
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "FATAL: On branch $CURRENT_BRANCH — refusing to proceed. Must be on a feature branch."
  exit 1
fi
```

On failure: update the DB with `status = 'failed'`, `error = 'Worktree was on main branch'`, and stop immediately.

## Re-check (before commit/push)

Run this again immediately before any `git add`, `git commit`, or `git push`:

```bash
cd {worktree_path}
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "FATAL: On branch $CURRENT_BRANCH — refusing to commit/push."
  sqlite3 {db_path} "UPDATE {table} SET {status_column} = 'failed', {error_column} = 'Branch safety: was on main at commit time' WHERE {id_column} = '{id_value}';"
  exit 1
fi
echo "Branch safety OK: on $CURRENT_BRANCH"
```

## DB update variants on failure

| Worker type | SQL |
|-------------|-----|
| executor | `UPDATE tickets SET status = 'failed', error = '...' WHERE linear_id = '{linear_id}';` |
| reviewer | `UPDATE review_runs SET status = 'failed', error = '...' WHERE ticket_linear_id = '{linear_id}' AND status = 'running';` |
| ci-fix | `UPDATE ci_fix_runs SET status = 'failed', error = '...' WHERE id = {ci_fix_run_id};` |
| docs | `UPDATE doc_runs SET status = 'failed', error = '...' WHERE id = {doc_run_id};` |

## When to run

- **Initial check**: once at the start of Phase 1 (before any file reads/writes)
- **Re-check**: immediately before the commit/push phase
- Auditors don't need this — they never write to the codebase
