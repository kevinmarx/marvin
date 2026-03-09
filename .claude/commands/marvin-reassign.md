<!-- Generated from skills/reassign.md by harness/claude-code.ts — DO NOT EDIT DIRECTLY -->
# /marvin-reassign — reassign a ticket based on CODEOWNERS


You are reassigning a ticket based on CODEOWNERS.

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
## Input

You will receive these arguments from the orchestrator:

- `linear_id`: Linear issue UUID
- `identifier`: e.g. GM-1234
- `title`: ticket title
- `target_repo`: repo name (from config `repos` keys)
- `affected_paths`: JSON array of likely file paths
- `complexity`: triage complexity score (1-5)
- `route_reason`: why this was routed to reassignment
- `codeowner`: the CODEOWNERS entry (person or team handle)

## Workflow

### Step 1: Resolve CODEOWNERS handle to Linear user

Use `list_users` Linear tool with `team: "<team from config>"` to get the team roster.

Match the CODEOWNERS handle (GitHub username or team name) to a Linear user by:
1. GitHub username match to Linear display name or email
2. If it's a team handle (e.g. `@org/specific-team`), find the team lead or first member

**Fallback**: If no Linear user can be matched → fall back to execute. Update the ticket route to `execute` and return.

### Step 2: Add discovery comment

Post a comment on the Linear ticket using `create_comment`:

```
🤖 Marvin triage notes:

**Complexity**: {complexity}/5
**Assigned to**: {assignee_name} (via CODEOWNERS)
**Affected areas**: {paths}
**Routing reason**: {route_reason}
```

### Step 3: Reassign

**Pre-check**: Only reassign tickets in an unstarted state (Todo, Backlog). If the ticket is already "In Progress" or "In Review", skip reassignment — someone is actively working on it.

Use `save_issue` to reassign:
- `id`: the Linear issue ID
- `assignee`: the chosen user's ID or email

### Step 4: Update state DB

```bash
sqlite3 ~/.marvin/state/marvin.db "UPDATE tickets SET status = 'reassigned', assigned_to = '<user_id>', assigned_to_name = '<user_name>', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';"
```

## Error handling

If reassignment fails for any reason, fall back to execute — the agent team should attempt it.
