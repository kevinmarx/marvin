# Phase: DT Ops — Housekeeping

You are a Deep Thought phase agent. Trim old data, reap stale scanner teammates, reconcile resolved findings, and record cycle stats. Then exit with a summary.

> Context: See helpers/context-dt.md

**Read config** from the path provided in the prompt (the `Config:` parameter). If no config path is provided, fall back to `config/deep-thought.json` (relative to the marvin repo root). Use `state_db` from config (default `~/.deep-thought/state/deep-thought.db`) as `DB_PATH`.

---

## 1. Trim old data

Keep cycle_events for 24 hours; old scan_runs for 7 days:
```sql
DELETE FROM cycle_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours');
DELETE FROM scan_runs WHERE finished_at IS NOT NULL AND finished_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days');
```

---

## 2. Reap stale scanner teammates

Read `stale_scanner_minutes` from `config.limits` (default 60).

Find scanner runs stuck in `running` beyond the timeout:

```sql
SELECT id, scanner_type, repo, last_phase
FROM scanner_runs
WHERE status = 'running'
  AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-<stale_scanner_minutes> minutes');
```

For each stale scanner run, use `last_phase` from the query (or `'unknown'` if null):

```sql
UPDATE scanner_runs
SET status = 'failed',
    error = 'Scanner timed out after <stale_scanner_minutes> minutes (last phase: <last_phase_or_unknown>)',
    finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = <run_id>;
```

Log a `cycle_events` entry for each reaped scanner:
```sql
INSERT INTO cycle_events (cycle_number, step, message)
VALUES (
  (SELECT cycle_number FROM heartbeat WHERE id = 1),
  'reaping',
  'Reaped stale scanner <scanner_type>-<repo> (last phase: <last_phase_or_unknown>, timeout: <stale_scanner_minutes>m)'
);
```

---

## 3. Reconcile resolved findings

Check if any tickets created by Deep Thought have been closed/cancelled/done in Linear. This prevents re-creating tickets for issues that have been addressed.

Query findings that have tickets:
```sql
SELECT id, ticket_linear_id, ticket_identifier
FROM findings
WHERE status = 'ticket_created'
  AND ticket_linear_id IS NOT NULL;
```

For each finding with a ticket, check the ticket's state in Linear using `get_issue`:
- If the ticket is in a completed state (Done, Cancelled, Closed): mark the finding as resolved:
```sql
UPDATE findings
SET status = 'resolved',
    resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = <finding_id>;
```

**Rate limit this check**: only check up to 20 findings per cycle to avoid hammering the Linear API.

---

## 4. Record cycle stats

Count activity from recent scan_runs:
```sql
SELECT
  COALESCE(SUM(alerts_checked), 0) as total_alerts,
  COALESCE(SUM(traces_checked), 0) as total_traces,
  COALESCE(SUM(log_patterns_checked), 0) as total_logs,
  COALESCE(SUM(scanners_run), 0) as total_scanners,
  COALESCE(SUM(findings_created), 0) as total_findings,
  COALESCE(SUM(tickets_created), 0) as total_tickets
FROM scan_runs
WHERE started_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-6 hours');
```

---

## Output

When done, print a single summary line to stdout and exit:

```
OPS: reaped=<N> reconciled=<N> trimmed=<yes/no>
```

Where `<N>` is the total number of stale items reaped and findings reconciled. This summary is what the orchestrator sees — keep it short.
