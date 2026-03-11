# Error handling pattern

When a phase fails, do three things: update the DB, comment on Linear (if applicable), log to cycle_events, then exit.

## DB update by worker type

### Executor / Explorer (tickets table)

```bash
sqlite3 {db_path} "
  UPDATE tickets SET status = 'failed', error = '{error_description}', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '{linear_id}';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '{identifier} {worker_type}: FAILED — {error_description}');
"
```

### Reviewer (review_runs table)

```bash
sqlite3 {db_path} "
  UPDATE review_runs SET status = 'failed', error = '{error_description}', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE ticket_linear_id = '{linear_id}' AND status = 'running';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '{identifier} reviewer: FAILED — {error_description}');
"
```

Leave `tickets.review_status` as-is so the orchestrator retries next cycle.

### CI fixer (ci_fix_runs + pull_requests tables)

```bash
sqlite3 {db_path} "
  UPDATE ci_fix_runs SET status = 'failed', error = '{error_description}', failure_type = '{failure_type}', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = {ci_fix_run_id};
  UPDATE pull_requests SET ci_fix_status = NULL, ci_fix_error = '{error_description}' WHERE repo = '{target_repo}' AND pr_number = {pr_number};
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'PR #{pr_number} ci-fix: FAILED — {error_description}');
"
```

### Auditor (audit_runs + pull_requests tables)

```bash
sqlite3 {db_path} "
  UPDATE audit_runs SET status = 'failed', error = '{error_description}', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = {audit_run_id};
  UPDATE pull_requests SET audit_status = NULL WHERE repo = '{target_repo}' AND pr_number = {pr_number};
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'PR #{pr_number} auditor: FAILED — {error_description}');
"
```

### Docs (doc_runs table)

```bash
sqlite3 {db_path} "
  UPDATE doc_runs SET status = 'failed', error = '{error_description}', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = {doc_run_id};
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '{identifier} docs: FAILED — {error_description}');
"
```

## Linear comment on failure

Post a comment for executor/explorer failures (tickets with a Linear issue):

```
Use MCP create_comment on {linear_id}:
  "Marvin encountered an error during {phase_name}: {error_description}"
```

Do NOT post Linear comments for reviewer/ci-fix/auditor/docs failures — those are tracked via the DB and PR comments.

## Exit vs continue

- **Exit**: branch safety failure, DB write failure, unrecoverable errors
- **Continue to next comment/file**: individual review comment failures, non-critical file read failures
- **Mark failed but don't exit**: when you need to clean up (remove temp files, update multiple DB tables)
