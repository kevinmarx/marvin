# Context: Phase PR

## Safety invariants

- Never create tickets in Linear — only update existing ones (comments, state changes, assignments)
- Never merge PRs — always create as draft, undraft only when CI passes and review comments are addressed
- Auto-approval only for risk:low PRs with passing CI (via audit workers)
- Never deploy anything
- Never modify main directly on target repos — always use worktrees branching from `origin/main`
- Always push with explicit refspec (`HEAD:refs/heads/<branch>`) — never rely on upstream tracking
- Always unset upstream tracking on new worktree branches to prevent accidental push to main
- Never force push
- Never read .env files

## State management

- SQLite database at `~/.marvin/state/marvin.db`
- Schema managed via numbered migrations in `schema/migrations/` — run `scripts/migrate.sh`
- All timestamps use `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` — never `datetime('now')`

### Database tables this phase reads/writes

| Table | Purpose |
|-------|---------|
| `pull_requests` | All open PRs, CI/review/audit status, merge conflict detection, auto-rebase tracking |
| `tickets` | Read for worktree info, update status on merge |
| `review_comments` | Individual PR review comments with addressing status |
| `review_runs` | Review processing sessions |
| `ci_fix_runs` | CI fix attempt tracking per PR |
| `audit_runs` | Audit attempt tracking per PR, with `findings_json` |
| `doc_runs` | Documentation follow-up PR tracking |
| `spawn_queue` | Worker spawn requests: phases queue, orchestrator drains and spawns |
| `cycle_events` | Per-cycle event log for dashboard activity (capped at 500 rows) |

## Worktree conventions

- Root: `<worktree_root from config>`
- Implementation branches: `<branch_prefix from config>/gm-{ticket_number}-{slug}`
- Documentation branches: `<branch_prefix from config>/docs-{identifier}`
- Always branch from `origin/main` after `git fetch origin main`
- Always unset upstream tracking after worktree creation

## Concurrency

- Max 8 concurrent workers enforced globally
- Count: executing/exploring tickets + running/queued audit_runs + running/queued review_runs + running/queued ci_fix_runs + running/queued doc_runs
- Phase-pr counts both `'running'` (actually spawned by orchestrator) and `'queued'` (inserted this cycle, awaiting spawn) to avoid over-committing slots
- The orchestrator's drain procedure only counts `'running'` since `'queued'` rows are what it's about to activate

## Queued vs running worker status

Phase-pr inserts `audit_runs`, `ci_fix_runs`, `review_runs`, and `doc_runs` rows with `status = 'queued'` (not `'running'`). The orchestrator activates them to `'running'` only when it actually spawns the worker.

## PR workflow

### CI status computation
`statusCheckRollup`: all `SUCCESS`/`NEUTRAL` → `success`; any `FAILURE` → `failure`; any `PENDING` → `pending`; no checks → `neutral`

### Undraft conditions
Draft PRs are undrafted when: `ci_status = 'success'` AND `unresolved_threads = 0` AND `mergeable = 'MERGEABLE'` AND no active rebase/review in progress.

### Auto-rebase
PRs behind main are rebased when: CI passing AND reviews addressed AND not currently being CI-fixed. Uses `--force-with-lease` for safety.

## Config fields used

- `team`, `assignee`, `repos`, `worktree_root`, `github_org`, `github_user`, `branch_prefix`, `marvin_repo_path`, `state_db`
- `limits.rebase_max_attempts` (default 3), `limits.rebase_min_interval_minutes` (default 10)
- `limits.ci_fix_max_attempts` (default 5), `limits.ci_fix_min_interval_minutes` (default 10)
