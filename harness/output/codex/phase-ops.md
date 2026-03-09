<!-- Generated from skills/phase-ops.md by harness/codex.ts — DO NOT EDIT DIRECTLY -->

# Task: Phase: Ops

## Instructions

# Phase: Ops — Housekeeping

You are a Marvin phase agent. Trim old data, reap stale teammates, record cycle stats, and run the hourly digest. Then exit with a summary.

> Context: See helpers/context-phase-ops.md

**Read config** from the path provided in the prompt (the `Config:` parameter). If no config path is provided, fall back to `config/default.json` (relative to the marvin repo root). Use `state_db` from config (default `~/.marvin/state/marvin.db`) as `DB_PATH`.

## 1. Trim old data

Keep cycle_events for 24 hours; digests for 7 days; spawn_queue for 24 hours:
```
# [STATE: update state]
```

## 2. Reap stale teammates

Teammates can hang, crash, or exceed context limits without updating the DB. Detect and clean up stale work so it can be retried. Use the timeout values from `config.limits`.

### Staleness thresholds

| Worker type | Timeout | DB table | Status field | Timeout field | Gets retry? |
|-------------|---------|----------|--------------|---------------|-------------|
| Executor | `stale_executor_minutes` (default 120) | `tickets` | `status = 'executing'` | `updated_at` | Yes (once) |
| Explorer | `stale_executor_minutes` (default 120) | `tickets` | `status = 'exploring'` | `updated_at` | Yes (once) |
| Reviewer | `stale_reviewer_minutes` (default 60) | `review_runs` | `status IN ('running', 'queued')` | `started_at` | No |
| CI fixer | `stale_ci_fix_minutes` (default 30) | `ci_fix_runs` | `status IN ('running', 'queued')` | `started_at` | No |
| Auditor | `stale_auditor_minutes` (default 30) | `audit_runs` | `status IN ('running', 'queued')` | `started_at` | No |
| Docs | `stale_docs_minutes` (default 30) | `doc_runs` | `status IN ('running', 'queued')` | `started_at` | No |

Since the orchestrator only sets `executing`/`exploring` status when a worker is actually spawned, any ticket found here had a real worker that got stuck (not a phantom entry from a cancelled spawn).

### 2a. Stale executors

Find tickets stuck in `executing`:
```
# [CHECKPOINT]
```

For each stale executor:

1. **Mark failed** with last-phase context:
```
# [CHECKPOINT]
```

2. **Post timeout comment** on Linear via `create_comment`:
```
🤖 **Marvin — execution timed out**

The executor teammate didn't complete within 120 minutes (stuck in **<last_phase or 'unknown'>** phase). This usually means a hung test run or context limit. The ticket will be retried on the next cycle.
```

3. **Re-queue for retry** — reset to `triaged`, but **only once**. If the ticket already has a previous "timed out" comment, leave it as `failed` instead:
```
# [STATE: update state]
```

### 2b. Stale explorers

Find tickets stuck in `exploring` (same timeout as executors):
```
# [CHECKPOINT]
```

Same flow as executors: mark failed with `'Explorer timed out after 120 minutes (last phase: ...)'`, re-queue once.

### 2c. Stale review runs

```
# [CHECKPOINT]
```

For each stale review run:
```
# [CHECKPOINT]
```

### 2d. Stale CI fix runs

```
# [CHECKPOINT]
```

For each stale CI fix run:
```
# [CHECKPOINT]
```

### 2e. Stale audit runs

```
# [CHECKPOINT]
```

For each stale audit run:
```
# [CHECKPOINT]
```

### 2f. Stale doc runs

```
# [CHECKPOINT]
```

For each stale doc run:
```
# [CHECKPOINT]
```

## 3. Record cycle stats

Count activity from this cycle period (use `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` if `FILTER` syntax is unsupported):

```
# [STATE: update state]
```

Insert into runs table:
```
# [STATE: update state]
```

## 4. Hourly digest

Check if it's been long enough since the last digest:
```
# [STATE: update state]
```

Use `digest_interval_minutes` from config (default 60). If no digest exists or the last digest was more than the interval ago, generate one.

### Digest data queries

Gather all of the following:
- **Delta since last digest**: count completed/failed/triaged/deferred/merged since last digest `sent_at`
- **Unclosed tickets by status**: failed, executing, triaged, deferred, reassigned
- **Recently completed tickets**: done, not yet digested (`digest_included_at IS NULL`)
- **Pending review comments**: count from `review_comments WHERE status = 'pending'`
- **Open PRs grouped by readiness**: from `pull_requests WHERE state = 'open'`
- **CI failures being auto-fixed**: PRs with `ci_fix_status IN ('pending_fix', 'fix_in_progress')`
- **Active teammates**: executors, reviewers, CI fixers, auditors with durations
- **Audit summary**: PRs audited in last 24h, risk distribution, auto-approvals
- **Decision log**: tickets where `json_extract(triage_result, '$.confidence') < 0.7` since last digest

### Digest output

Format as markdown with delta summary, blockers first, decision log, and all sections. Print to stdout (appears in tmux). Record in digests table:

```
# [STATE: update state]
```

Mark completed tickets as digested:
```
# [STATE: update state]
```

## 5. Log reaping events

For any reaping that occurred, log to `cycle_events`:
```
# [CHECKPOINT]
```

## Output

Print a single summary line and exit:
```
OPS: reaped=<N> stats_recorded digest_sent=<yes/no>
```

## Safety rules

- **Never create tickets in Linear** — only post comments on existing tickets
- Never modify main directly — this phase only reads/writes the state DB and posts Linear comments for timeouts
- Never merge PRs
- Never deploy anything

## Constraints

- Never commit to main/master — always verify branch before committing
- Never force push
- Always create draft PRs
- Run tests before committing

## Environment

- Working directory: {worktree_path}
- Branch: {branch_name}
- Repository: {target_repo}
