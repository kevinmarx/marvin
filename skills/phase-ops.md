# Phase: Ops — Housekeeping

You are a Marvin phase agent. Trim old data, reap stale teammates, record cycle stats, and run the hourly digest. Then exit with a summary.

> Context: See helpers/context-phase-ops.md

**Read config** from the path provided in the prompt (the `Config:` parameter). If no config path is provided, fall back to `config/default.json` (relative to the marvin repo root). Use `state_db` from config (default `~/.marvin/state/marvin.db`) as `DB_PATH`.

**Heartbeat refresh**: Before each major step below, refresh the orchestrator heartbeat so the dashboard stays green during long-running phases:
```sql
UPDATE heartbeat SET last_beat_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = 1;
```

## 1. Trim old data

Keep cycle_events for 24 hours; digests for 7 days; spawn_queue for 24 hours:
```sql
DELETE FROM cycle_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours');
DELETE FROM digests WHERE sent_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days');
DELETE FROM spawn_queue WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours');
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
```sql
SELECT linear_id, identifier, title, last_phase
FROM tickets
WHERE status = 'executing'
  AND updated_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-120 minutes');
```

For each stale executor:

1. **Mark failed** with last-phase context:
```sql
UPDATE tickets
SET status = 'failed',
    error = 'Executor timed out after 120 minutes (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE linear_id = '<linear_id>' AND status = 'executing';
```

2. **Post timeout comment** on Linear via `create_comment`:
```
🤖 **Marvin — execution timed out**

The executor teammate didn't complete within 120 minutes (stuck in **<last_phase or 'unknown'>** phase). This usually means a hung test run or context limit. The ticket will be retried on the next cycle.
```

3. **Re-queue for retry** — reset to `triaged`, but **only once**. If the ticket already has a previous "timed out" comment, leave it as `failed` instead:
```sql
UPDATE tickets
SET status = 'triaged',
    error = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE linear_id = '<linear_id>' AND status = 'failed'
  AND error LIKE '%timed out%';
```

### 2b. Stale explorers

Find tickets stuck in `exploring` (same timeout as executors):
```sql
SELECT linear_id, identifier, title, last_phase
FROM tickets
WHERE status = 'exploring'
  AND updated_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-120 minutes');
```

Same flow as executors: mark failed with `'Explorer timed out after 120 minutes (last phase: ...)'`, re-queue once.

### 2c. Stale review runs

```sql
SELECT id, ticket_linear_id, pr_number, last_phase
FROM review_runs
WHERE status IN ('running', 'queued')
  AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-60 minutes');
```

For each stale review run:
```sql
UPDATE review_runs
SET status = 'failed',
    error = 'Review teammate timed out after 60 minutes (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
    finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = <run_id>;

-- Reset review_status so next cycle can re-detect pending comments and spawn a new reviewer
UPDATE tickets
SET review_status = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE linear_id = '<ticket_linear_id>'
  AND review_status = 'review_in_progress';
```

### 2d. Stale CI fix runs

```sql
SELECT id, repo, pr_number, last_phase
FROM ci_fix_runs
WHERE status IN ('running', 'queued')
  AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 minutes');
```

For each stale CI fix run:
```sql
UPDATE ci_fix_runs
SET status = 'failed',
    error = 'CI-fix teammate timed out after 30 minutes (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
    finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = <run_id>;

-- Reset ci_fix_status so orchestrator re-evaluates next cycle (count already incremented)
UPDATE pull_requests
SET ci_fix_status = NULL,
    ci_fix_error = 'CI-fix teammate timed out after 30 minutes'
WHERE repo = '<repo>' AND pr_number = <pr_number>
  AND ci_fix_status = 'fix_in_progress';
```

### 2e. Stale audit runs

```sql
SELECT id, repo, pr_number, last_phase
FROM audit_runs
WHERE status IN ('running', 'queued')
  AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 minutes');
```

For each stale audit run:
```sql
UPDATE audit_runs
SET status = 'failed',
    error = 'Audit teammate timed out after 30 minutes (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
    finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = <run_id>;

-- Reset audit_status so PR gets picked up for audit again next cycle
UPDATE pull_requests
SET audit_status = NULL
WHERE repo = '<repo>' AND pr_number = <pr_number>
  AND audit_status = 'audit_in_progress';
```

### 2f. Stale doc runs

```sql
SELECT id, ticket_identifier, repo, last_phase
FROM doc_runs
WHERE status IN ('running', 'queued')
  AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 minutes');
```

For each stale doc run:
```sql
UPDATE doc_runs
SET status = 'failed',
    error = 'Docs teammate timed out (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
    finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = <run_id>;
```

## 3. Record cycle stats

Count activity from this cycle period (use `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` if `FILTER` syntax is unsupported):

```sql
SELECT
  COUNT(*) FILTER (WHERE triaged_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as found,
  COUNT(*) FILTER (WHERE status = 'triaged' AND triaged_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as triaged,
  COUNT(*) FILTER (WHERE status IN ('executing', 'done') AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as executed,
  COUNT(*) FILTER (WHERE route = 'reassign' AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as reassigned,
  COUNT(*) FILTER (WHERE status = 'deferred' AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as deferred,
  COUNT(*) FILTER (WHERE status = 'failed' AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as failed
FROM tickets;
```

Insert into runs table:
```sql
INSERT INTO runs (tickets_found, tickets_triaged, tickets_executed, tickets_reassigned, tickets_deferred, tickets_failed, finished_at)
VALUES (<found>, <triaged>, <executed>, <reassigned>, <deferred>, <failed>, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
```

## 4. Hourly digest

Check if it's been long enough since the last digest:
```sql
SELECT sent_at FROM digests ORDER BY sent_at DESC LIMIT 1;
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

```sql
INSERT INTO digests (ticket_ids, content) VALUES ('<json_array_of_ids>', '<digest_content>');
```

Mark completed tickets as digested:
```sql
UPDATE tickets
SET digest_included_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE status = 'done'
  AND (digest_included_at IS NULL OR digest_included_at = '');
```

## 5. Log reaping events

For any reaping that occurred, log to `cycle_events`:
```sql
INSERT INTO cycle_events (cycle_number, step, message)
VALUES (<cycle>, 'reaping', '<message — include last_phase, e.g. "Reaped stale executor GM-1234 (stuck in explore phase)">');
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
