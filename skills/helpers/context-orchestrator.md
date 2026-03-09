# Context: Orchestrator

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
- Human review is always required before merging (except risk:low auto-approvals)

## State management

- SQLite database at `~/.marvin/state/marvin.db`
- Schema managed via numbered migrations in `schema/migrations/` — run `scripts/migrate.sh`
- All timestamps use `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` — never `datetime('now')`

### Key database tables

| Table | Purpose |
|-------|---------|
| `heartbeat` | Singleton row: orchestrator liveness (cycle number, current step, last beat) |
| `tickets` | Core ticket tracking — read for concurrency counting |
| `spawn_queue` | Worker spawn requests: phases queue, orchestrator drains and spawns |
| `cycle_events` | Per-cycle event log for dashboard activity (capped at 500 rows) |
| `audit_runs` | Read for concurrency counting |
| `review_runs` | Read for concurrency counting |
| `ci_fix_runs` | Read for concurrency counting |
| `doc_runs` | Read for concurrency counting |

## Cycle structure

```
Phase 1: phaseOps() — reap stale workers, trim data, record stats, digest
Phase 2: phaseTriage() — reassess, poll Linear, triage, route
  → drainAndSpawn() — spawn executors/explorers
Phase 3: phasePR() — poll PRs, rebase, CI-fix, audit, review, undraft, docs
  → drainAndSpawn() — spawn CI-fix/audit/review/docs workers
Self-restart check → Sleep
```

## Spawn queue and concurrency

- **Concurrency limit**: 8 concurrent workers max, enforced in-memory by SpawnManager
- Phases return `SpawnRequest[]`; orchestrator spawns workers via `child_process.fork()`
- Workers communicate back via Node IPC: `heartbeat`, `complete`, `failed` messages
- Before draining the spawn queue, count running workers (executing/exploring tickets + running audit/review/ci_fix/doc runs). Only `8 - running` workers are spawned

## Status lifecycle

Ticket status (`executing`/`exploring`) is ONLY set by the orchestrator when it actually spawns a worker — never by the triage phase. This prevents zombie tickets that count toward concurrency limits but have no running worker. When the orchestrator cancels pending spawns (due to concurrency limits), it rolls the ticket status back to `triaged`.

## Self-restart

After a configured number of cycles (`self_restart_after_cycles`, default 48, ~24 hours), the orchestrator exits cleanly and the wrapper script (`run-marvin.sh`) restarts it with a fresh context.

## Config fields used

- `team`, `assignee`, `repos`, `worktree_root`, `github_org`, `github_user`, `branch_prefix`, `marvin_repo_path`, `state_db`
- `cycle_interval_seconds` (default 1800), `self_restart_after_cycles` (default 48)
- `limits.max_concurrent_workers` (default 8)
