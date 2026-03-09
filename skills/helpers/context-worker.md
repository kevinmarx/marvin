# Context: Worker

## Safety invariants

- Never create tickets in Linear — only update existing ones (comments, state changes, assignments)
- Never merge PRs — always create as draft, undraft only when CI passes and review comments are addressed
- Auto-approval only for risk:low PRs with passing CI (via audit workers)
- Never deploy anything
- Never modify main directly on target repos — always use worktrees branching from `origin/main`
- Always push with explicit refspec (`HEAD:refs/heads/<branch>`) — never rely on upstream tracking
- Always unset upstream tracking on new worktree branches to prevent accidental push to main
- Branch safety re-check before every commit/push in all worker skills
- Never force push
- Never read .env files
- Human review is always required before merging (except risk:low auto-approvals)

## State management

- SQLite database at `~/.marvin/state/marvin.db`
- Schema managed via numbered migrations in `schema/migrations/` — run `scripts/migrate.sh`
- All timestamps use `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` — never `datetime('now')`

### Database tables

| Table | Purpose |
|-------|---------|
| `tickets` | Core ticket tracking, triage results, execution status, PR info, defer fields |
| `pull_requests` | All open PRs, CI/review/audit status, merge conflict detection, auto-rebase tracking |
| `review_comments` | Individual PR review comments with addressing status |
| `review_runs` | Review processing sessions |
| `ci_fix_runs` | CI fix attempt tracking per PR |
| `audit_runs` | Audit attempt tracking per PR, with `findings_json` |
| `doc_runs` | Documentation follow-up PR tracking |
| `heartbeat` | Singleton row: orchestrator liveness (cycle number, current step, last beat) |
| `cycle_events` | Per-cycle event log for dashboard activity (capped at 500 rows) |

## Worker types

| Role | Skill | Spawned by | What it does |
|------|-------|-----------|--------------|
| Executor | `execute` | phase-triage | Explore → plan → implement → test → commit → push → draft PR |
| Explorer | `explore` | phase-triage | Investigate codebase → post findings to Linear (complexity ≥ 3, no implementation) |
| Docs | `docs` | phase-pr | Read executor knowledge → update CLAUDE.md/READMEs → docs PR |
| Reviewer | `review` | phase-pr | Sync worktree → address review comments → commit → push |
| CI fixer | `ci_fix` | phase-pr | Investigate CI failure → fix → test → push |
| Auditor | `audit` | phase-pr | Classify size → architectural review → risk assess → label/approve |

## Worktree conventions

- Root: `<worktree_root from config>`
- Implementation branches: `<branch_prefix from config>/gm-{ticket_number}-{slug}`
- Documentation branches: `<branch_prefix from config>/docs-{identifier}`
- Always branch from `origin/main` after `git fetch origin main`
- Always unset upstream tracking after worktree creation
- Cleanup: `scripts/cleanup-worktrees.sh [--dry-run]`

## Git conventions

- Always push with explicit refspec: `git push -u origin HEAD:refs/heads/<branch_name>`
- Never rely on upstream tracking — always use explicit refspec
- Always unset upstream on new worktree branches: `git branch --unset-upstream "$BRANCH" 2>/dev/null || true`
- Branch safety re-check before every commit/push phase

## Repo mappings

Repos are configured in `config.json` under the `repos` key. Each entry maps a repo name to its local path.
