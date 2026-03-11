<!-- Generated from skills/digest.md by harness/claude-code.ts — DO NOT EDIT DIRECTLY -->
# /marvin-digest — executive summary of Marvin's work


You are generating an executive summary of what Marvin has accomplished and what needs attention.

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
## Workflow

### Step 1: Gather data

Run all queries to collect raw data:

```bash
# Last digest timestamp (for delta calculations)
sqlite3 ~/.marvin/state/marvin.db "
  SELECT sent_at FROM digests ORDER BY sent_at DESC LIMIT 1;
"
# If no result, use '-24 hours' as the baseline

# Delta since last digest
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT
    SUM(CASE WHEN status = 'done' AND updated_at > COALESCE((SELECT sent_at FROM digests ORDER BY sent_at DESC LIMIT 1), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours')) THEN 1 ELSE 0 END) as completed,
    SUM(CASE WHEN status = 'failed' AND updated_at > COALESCE((SELECT sent_at FROM digests ORDER BY sent_at DESC LIMIT 1), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours')) THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN status = 'triaged' AND triaged_at > COALESCE((SELECT sent_at FROM digests ORDER BY sent_at DESC LIMIT 1), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours')) THEN 1 ELSE 0 END) as triaged,
    SUM(CASE WHEN status = 'deferred' AND updated_at > COALESCE((SELECT sent_at FROM digests ORDER BY sent_at DESC LIMIT 1), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours')) THEN 1 ELSE 0 END) as deferred
  FROM tickets;
"

# Recently completed tickets (not yet digested)
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT identifier, title, complexity, pr_url, pr_number, executed_at, target_repo
  FROM tickets
  WHERE status = 'done'
    AND (digest_included_at IS NULL OR digest_included_at = '')
  ORDER BY executed_at ASC;
"

# Failed tickets
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT identifier, title, error, updated_at
  FROM tickets WHERE status = 'failed'
  ORDER BY updated_at DESC;
"

# Currently executing
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT identifier, title, complexity, target_repo, updated_at
  FROM tickets WHERE status = 'executing';
"

# Queued for execution
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT identifier, title, complexity
  FROM tickets WHERE status = 'triaged' AND route = 'execute';
"

# Deferred tickets
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT identifier, title, defer_status, defer_followup_count,
    CAST((julianday('now') - julianday(created_at)) AS INTEGER) as days_waiting
  FROM tickets WHERE status = 'deferred';
"

# PRs ready to merge
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, title FROM pull_requests
  WHERE state = 'open' AND ready_to_merge = 1;
"

# PRs needing attention (open, not draft, not ready)
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, title, ci_status, review_decision, unresolved_threads
  FROM pull_requests
  WHERE state = 'open' AND is_draft = 0 AND ready_to_merge = 0;
"

# CI failures
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, ci_fix_count, ci_fix_status, ci_fix_error
  FROM pull_requests
  WHERE state = 'open' AND ci_status = 'failure';
"

# Audit stats (last 24h)
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN risk_level = 'low' THEN 1 ELSE 0 END) as low,
    SUM(CASE WHEN risk_level = 'medium' THEN 1 ELSE 0 END) as medium,
    SUM(CASE WHEN risk_level = 'high' THEN 1 ELSE 0 END) as high,
    SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) as approved
  FROM audit_runs
  WHERE status = 'completed'
    AND finished_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours');
"

# Active teammates
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT 'executor' as role, identifier as name, updated_at as started
  FROM tickets WHERE status = 'executing'
  UNION ALL
  SELECT 'reviewer', t.identifier, rr.started_at
  FROM review_runs rr LEFT JOIN tickets t ON t.linear_id = rr.ticket_linear_id
  WHERE rr.status IN ('running', 'queued')
  UNION ALL
  SELECT 'ci-fixer', repo || ' #' || pr_number, started_at
  FROM ci_fix_runs WHERE status IN ('running', 'queued')
  UNION ALL
  SELECT 'auditor', repo || ' #' || pr_number, started_at
  FROM audit_runs WHERE status IN ('running', 'queued');
"

# Review activity (last 24h)
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT t.identifier, rr.comments_addressed, rr.commits_pushed
  FROM review_runs rr
  JOIN tickets t ON t.linear_id = rr.ticket_linear_id
  WHERE rr.status = 'completed'
    AND rr.finished_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours');
"

# Pending review comments
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT t.identifier, COUNT(*) as pending
  FROM review_comments rc
  JOIN tickets t ON t.linear_id = rc.ticket_linear_id
  WHERE rc.status = 'pending'
  GROUP BY t.identifier;
"

# Low-confidence triages since last digest
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT identifier, title, route,
    json_extract(triage_result, '$.confidence') as confidence,
    json_extract(triage_result, '$.route_reason') as route_reason,
    json_extract(triage_result, '$.recommended_assignee') as recommended_assignee
  FROM tickets
  WHERE triage_result IS NOT NULL
    AND json_extract(triage_result, '$.confidence') < 0.7
    AND triaged_at > COALESCE((SELECT sent_at FROM digests ORDER BY sent_at DESC LIMIT 1), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours'));
"

# Reassignments since last digest
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT identifier, title,
    json_extract(triage_result, '$.recommended_assignee') as assignee
  FROM tickets
  WHERE route = 'reassign'
    AND updated_at > COALESCE((SELECT sent_at FROM digests ORDER BY sent_at DESC LIMIT 1), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours'));
"
```

### Step 2: Write the digest

Synthesize data into a narrative summary. Print to stdout as markdown.

#### Format

```
# Marvin — {date} {time} digest

**Since last digest**: {delta — e.g. "2 tickets completed, 1 failed, 3 triaged, 1 new blocker"}

## Blockers
<!-- Things that require human action. Skip section if empty. -->
{Failed tickets — what failed and what to do}
{CI fixes exhausted — PR link, failure type, what was tried}
{Deferred tickets stale >3 days — how long, what question was asked}
{Pending review comments not addressed}

## Shipped
<!-- Skip if nothing completed. -->
{Each: "Shipped {outcome} (GM-XXXX) → PR #N"}

## In flight
<!-- Only if there are executing tickets or active teammates -->
{Executing tickets with duration}
{Active teammates}

## Decision log
<!-- Skip if no low-confidence triages, reassignments, or defers since last digest -->
{Low-confidence triages (<0.7) — what was decided and why uncertain}
{Reassignments — who got what}
{Defers — what question was asked}

## PRs ready to merge
<!-- Skip if none -->
{PR #N: title (repo) — CI green, approved, 0 threads}

## Audit summary
<!-- Skip if no audits in last 24h -->
{One line: Audited N PRs, risk distribution, auto-approvals}
```

#### Writing style

- **Lead with outcomes**, not process. "Fixed the MFA bypass bug" not "Executed ticket GM-1560"
- **Be specific about blockers**. "PR #170 ready to merge — CI green, approved, 0 threads" not "1 PR ready"
- **Quantify when useful**. "Audited 12 PRs (8 low risk, 3 medium, 1 high)" not "Audited PRs"
- **Skip empty sections entirely** — don't print headers with "None" under them
- **Keep it under 40 lines** — scannable in 30 seconds
- **Section priority**: blockers first, then shipped, then in flight

### Step 3: Mark completed tickets as digested

```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets
  SET digest_included_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE status IN ('done')
    AND (digest_included_at IS NULL OR digest_included_at = '');
"
```

### Step 4: Record digest

```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO digests (ticket_ids, content)
  VALUES ('<json_array_of_ids>', '<digest_content>');
"
```
