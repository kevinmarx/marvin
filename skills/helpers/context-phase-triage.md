# Context: Phase Triage

## Safety invariants

- Never create tickets in Linear — only update existing ones (comments, state changes, assignments)
- Never merge PRs — always create as draft, undraft only when CI passes and review comments are addressed
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
| `tickets` | Core ticket tracking, triage results, execution status, PR info, defer fields |
| `spawn_queue` | Worker spawn requests: phases queue, orchestrator drains and spawns |
| `reassess_requests` | Dashboard → orchestrator queue for manual re-triage requests |
| `cycle_events` | Per-cycle event log for dashboard activity (capped at 500 rows) |
| `audit_runs` | Read for concurrency counting |
| `review_runs` | Read for concurrency counting |
| `ci_fix_runs` | Read for concurrency counting |
| `doc_runs` | Read for concurrency counting |

## Triage prompt

The triage prompt template is at `prompts/triage.md`. It produces a JSON object with:
- `complexity` (1-5)
- `target_repo`
- `affected_paths[]`
- `route` (execute/reassign/defer)
- `route_reason`
- `confidence` (0-1)
- `risks[]`
- `implementation_hint`
- `recommended_assignee`

### Routing rules

| Route | When | Action |
|-------|------|--------|
| `execute` | No specific CODEOWNERS entry, complexity ≤ `complexity_threshold` (default 2) | Assign to configured assignee, setup worktree, spawn executor |
| `explore` | No specific CODEOWNERS entry, complexity > `complexity_threshold` | Assign to configured assignee, setup worktree, spawn explorer |
| `reassign` | Specific CODEOWNERS entry exists | Reassign in Linear to that person |
| `defer` | Can't determine repo/area | Post clarifying questions |

## Config fields used

- `team`, `assignee`, `linear_user`, `repos`, `worktree_root`, `github_org`, `github_user`, `branch_prefix`, `marvin_repo_path`, `labels.platform`, `complexity_threshold` (default 2), `confidence_threshold` (default 0.7), `ticket_states`, `claim_unassigned` (default false), `state_db`

## Worktree conventions

- Root: `<worktree_root from config>`
- Implementation branches: `<branch_prefix from config>/gm-{ticket_number}-{slug}`
- Always branch from `origin/main` after `git fetch origin main`
- Always unset upstream tracking after worktree creation

## Concurrency

- Max 8 concurrent workers enforced globally
- Count: executing/exploring tickets + running/queued audit_runs + running/queued review_runs + running/queued ci_fix_runs + running/queued doc_runs
- Reassign and defer routes are NOT affected by the concurrency limit

## Status lifecycle

This phase must **NEVER** set ticket status to `executing` or `exploring`. Tickets remain `triaged`. The orchestrator sets `executing`/`exploring` when it spawns the worker. This phase only stores worktree metadata and queues spawn requests.
