# Context: Phase Ops

## Safety invariants

- Never create tickets in Linear — only update existing ones (comments, state changes, assignments)
- Never merge PRs — always create as draft, undraft only when CI passes and review comments are addressed
- Never deploy anything
- Never modify main directly on target repos — always use worktrees branching from `origin/main`
- Never force push
- Never read .env files

## State management

- SQLite database at `~/.marvin/state/marvin.db`
- Schema managed via numbered migrations in `schema/migrations/` — run `scripts/migrate.sh`
- All timestamps use `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` — never `datetime('now')`

### Database tables this phase reads/writes

| Table | Purpose |
|-------|---------|
| `tickets` | Reap stale executors/explorers, read for stats |
| `runs` | Per-cycle stats (tickets found/triaged/executed/failed) |
| `digests` | Hourly digest history |
| `audit_runs` | Reap stale auditors |
| `review_runs` | Reap stale reviewers |
| `ci_fix_runs` | Reap stale CI fixers |
| `doc_runs` | Reap stale docs workers |
| `cycle_events` | Per-cycle event log, trimmed to 500 rows |
| `spawn_queue` | Trimmed to remove old completed/cancelled entries |
| `heartbeat` | Read for cycle number |

## Reaping thresholds

Workers are reaped (marked as failed/timed out) if they haven't updated `last_phase_at` within their stale threshold:

| Worker type | Stale after (minutes) | DB table | Status field |
|------------|----------------------|----------|-------------|
| Executor | `stale_executor_minutes` (default 120) | `tickets` | `status = 'executing'` |
| Explorer | `stale_executor_minutes` (default 120) | `tickets` | `status = 'exploring'` |
| Reviewer | `stale_reviewer_minutes` (default 60) | `review_runs` | `status = 'running'` |
| CI fixer | `stale_ci_fix_minutes` (default 30) | `ci_fix_runs` | `status = 'running'` |
| Auditor | `stale_auditor_minutes` (default 30) | `audit_runs` | `status = 'running'` |
| Docs | `stale_docs_minutes` (default 30) | `doc_runs` | `status = 'running'` |

## Data retention rules

- `cycle_events`: capped at 500 rows
- `digests`: retained indefinitely
- `spawn_queue`: old completed/cancelled entries trimmed

## Digest

Hourly digest generation controlled by `digest_interval_minutes` from config (default 120). Summarizes: what got done, what's in flight, what needs attention.
