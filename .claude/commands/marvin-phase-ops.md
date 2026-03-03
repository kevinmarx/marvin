# /marvin-phase-ops — Housekeeping phase

You are a Marvin phase agent. Your job: reap stale teammates, record cycle stats, run the hourly digest, and trim old data. Then exit with a summary.

**Read config** from the path provided in the prompt (the `Config:` parameter). If no config path is provided, fall back to `config/default.json` (relative to the marvin repo root).

## Constants

```
DB_PATH="$HOME/.marvin/state/marvin.db"
```

## 1. Trim old data

Keep cycle_events for 24 hours; digests for 7 days; spawn_queue for 24 hours:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  DELETE FROM cycle_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours');
  DELETE FROM digests WHERE sent_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days');
  DELETE FROM spawn_queue WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours');
"
```

## 2. Reap stale teammates

Teammates can hang, crash, or exceed context limits without updating the DB. Detect and clean up stale work so it can be retried. Use the timeout values from `config.limits`.

### 2a. Stale executors

Tickets stuck in `executing` with no progress beyond the timeout. **Note**: since the orchestrator now only sets `executing` status when a worker is actually spawned, any ticket found here had a real worker that got stuck (not a phantom entry from a cancelled spawn):
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT linear_id, identifier, title, last_phase
  FROM tickets
  WHERE status = 'executing'
    AND updated_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-120 minutes');
"
```

For each stale executor:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets
  SET status = 'failed',
      error = 'Executor timed out after 120 minutes (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<linear_id>' AND status = 'executing';
"
```

Post a comment on the Linear ticket noting the timeout so it's visible:
```bash
# Use create_comment Linear MCP tool:
# issueId: <linear_id>
# body: "🤖 **Marvin — execution timed out**\n\nThe executor teammate didn't complete within 120 minutes (stuck in **<last_phase or 'unknown'>** phase). This usually means a hung test run or context limit. The ticket will be retried on the next cycle."
```

Then re-queue the ticket for retry by resetting to `triaged`:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets
  SET status = 'triaged',
      error = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<linear_id>' AND status = 'failed'
    AND error LIKE '%timed out%';
"
```

**Note**: Only retry once. If the ticket was already retried (check if there's a previous "timed out" comment on the ticket), leave it as `failed` instead of re-queuing.

### 2a2. Stale explorers

Tickets stuck in `exploring` with no progress beyond the timeout (same as executor timeout). Same note applies — these are real spawned workers, not phantoms:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT linear_id, identifier, title, last_phase
  FROM tickets
  WHERE status = 'exploring'
    AND updated_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-120 minutes');
"
```

For each stale explorer:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets
  SET status = 'failed',
      error = 'Explorer timed out after 120 minutes (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<linear_id>' AND status = 'exploring';
"
```

Re-queue for retry (same once-only rule as executors):
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets
  SET status = 'triaged',
      error = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<linear_id>' AND status = 'failed'
    AND error LIKE '%Explorer timed out%';
"
```

### 2b. Stale review runs

Review runs stuck in `running` beyond the reviewer timeout:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT id, ticket_linear_id, pr_number, last_phase
  FROM review_runs
  WHERE status = 'running'
    AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-60 minutes');
"
```

For each stale review run:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE review_runs
  SET status = 'failed',
      error = 'Review teammate timed out after 60 minutes (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
      finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE id = <run_id>;
"

sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets
  SET review_status = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<ticket_linear_id>'
    AND review_status = 'review_in_progress';
"
```

Resetting `review_status` to NULL allows the next cycle to detect the pending comments and spawn a new reviewer.

### 2c. Stale CI fix runs

CI fix runs stuck in `running` beyond the ci-fix timeout:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT id, repo, pr_number, last_phase
  FROM ci_fix_runs
  WHERE status = 'running'
    AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 minutes');
"
```

For each stale CI fix run:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE ci_fix_runs
  SET status = 'failed',
      error = 'CI-fix teammate timed out after 30 minutes (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
      finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE id = <run_id>;
"

sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests
  SET ci_fix_status = NULL,
      ci_fix_error = 'CI-fix teammate timed out after 30 minutes'
  WHERE repo = '<repo>' AND pr_number = <pr_number>
    AND ci_fix_status = 'fix_in_progress';
"
```

Resetting `ci_fix_status` to NULL lets the orchestrator re-evaluate on the next cycle. The count was already incremented when the teammate was spawned, so no double-counting.

### 2d. Stale audit runs

Audit runs stuck in `running` beyond the auditor timeout:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT id, repo, pr_number, last_phase
  FROM audit_runs
  WHERE status = 'running'
    AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 minutes');
"
```

For each stale audit run:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE audit_runs
  SET status = 'failed',
      error = 'Audit teammate timed out after 30 minutes (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
      finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE id = <run_id>;
"

sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests
  SET audit_status = NULL
  WHERE repo = '<repo>' AND pr_number = <pr_number>
    AND audit_status = 'audit_in_progress';
"
```

Resetting `audit_status` to NULL lets the PR be picked up for audit again on the next cycle.

### 2e. Stale doc runs

Doc runs stuck in `running` beyond the docs timeout:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT id, ticket_identifier, repo, last_phase
  FROM doc_runs
  WHERE status = 'running'
    AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 minutes');
"
```

For each stale doc run:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE doc_runs
  SET status = 'failed',
      error = 'Docs teammate timed out (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
      finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE id = <run_id>;
"
```

## 3. Record cycle stats

Count the activity from this cycle period. Query tickets with recent `updated_at` timestamps:

```bash
sqlite3 ~/.marvin/state/marvin.db "INSERT INTO runs (tickets_found, tickets_triaged, tickets_executed, tickets_reassigned, tickets_deferred, tickets_failed, finished_at) VALUES (<found>, <triaged>, <executed>, <reassigned>, <deferred>, <failed>, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));"
```

To determine counts, query:
```bash
# Tickets triaged/executed/etc. in the last cycle interval
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT
    COUNT(*) FILTER (WHERE triaged_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as found,
    COUNT(*) FILTER (WHERE status = 'triaged' AND triaged_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as triaged,
    COUNT(*) FILTER (WHERE status IN ('executing', 'done') AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as executed,
    COUNT(*) FILTER (WHERE route = 'reassign' AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as reassigned,
    COUNT(*) FILTER (WHERE status = 'deferred' AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as deferred,
    COUNT(*) FILTER (WHERE status = 'failed' AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')) as failed
  FROM tickets;
"
```

If the `FILTER` syntax doesn't work in your SQLite version, use `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` instead.

## 4. Hourly digest

Check if it's been long enough since the last digest:

```bash
LAST_DIGEST=$(sqlite3 ~/.marvin/state/marvin.db "SELECT sent_at FROM digests ORDER BY sent_at DESC LIMIT 1;")
INTERVAL_MINUTES=60  # or read from config digest_interval_minutes, default 60
```

If no digest exists or the last digest was more than `INTERVAL_MINUTES` ago, generate one:

a. **Query all the same data as `/marvin-digest`**:
   - Delta since last digest: count completed/failed/triaged/deferred/merged since last digest `sent_at`
   - Unclosed tickets by status (failed, executing, triaged, deferred, reassigned)
   - Recently completed tickets (done, not yet digested)
   - Pending review comments
   - Open PRs grouped by readiness
   - CI failures being auto-fixed
   - Active teammates with durations (executors, reviewers, CI fixers, auditors)
   - Audit summary: PRs audited in last 24h, risk distribution, auto-approvals
   - Decision log: tickets where `json_extract(triage_result, '$.confidence') < 0.7` since last digest

b. **Format as markdown** following the template in `/marvin-digest`, including delta summary, blockers first, decision log, and all other sections.

c. **Print to stdout** so it appears in the orchestrator's tmux output.

d. **Record in the digests table**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO digests (ticket_ids, content)
  VALUES ('<json_array_of_ids>', '<digest_content>');
"
```

e. **Mark completed tickets as digested**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets
  SET digest_included_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE status = 'done'
    AND (digest_included_at IS NULL OR digest_included_at = '');
"
```

The digest goes to stdout (visible in tmux) and the `digests` table (visible on the dashboard). No Linear posting — it's a local status report.

## 5. Log events for significant actions

For any reaping that occurred, log to `cycle_events`:
```bash
CYCLE=$(sqlite3 ~/.marvin/state/marvin.db "SELECT cycle_number FROM heartbeat WHERE id = 1;")
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO cycle_events (cycle_number, step, message)
  VALUES ($CYCLE, 'reaping', '<message about what was reaped, including last_phase if available — e.g. Reaped stale executor GM-1234 (stuck in explore phase)>');
"
```

## Output

When done, print a single summary line to stdout and exit:

```
OPS: reaped=<N> stats_recorded digest_sent=<yes/no>
```

Where `<N>` is the total number of stale items reaped across all types. This summary is what the orchestrator (EM) sees — keep it short.

## Safety rules

- **Never create tickets in Linear** — only post comments on existing tickets
- Never modify main directly — this phase only reads/writes the state DB and posts Linear comments for timeouts
- Never merge PRs
- Never deploy anything
