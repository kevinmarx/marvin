# Phase checkpoint pattern

Workers MUST checkpoint at the start of every phase. The ops phase uses `last_phase` and `last_phase_at` to detect stuck workers. If you don't checkpoint, you'll be reaped as stale.

## SQL template

Run BOTH statements together — update liveness AND log to dashboard:

```bash
sqlite3 {db_path} "
  UPDATE {table} SET last_phase = '{phase_name}', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'){extra_columns} WHERE {id_column} = '{id_value}';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '{identifier} {worker_type}: entering phase {phase_name}');
"
```

## Table variants

| Worker type | Table | ID column | Extra columns in UPDATE |
|-------------|-------|-----------|------------------------|
| executor | `tickets` | `linear_id` | `, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` |
| explorer | `tickets` | `linear_id` | `, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` |
| reviewer | `review_runs` | `ticket_linear_id` | (none — add `AND status = 'running'` to WHERE) |
| ci-fix | `ci_fix_runs` | `id` | (none) |
| auditor | `audit_runs` | `id` | (none) |
| docs | `doc_runs` | `id` | (none) |
| DT scanner | `scanner_runs` | (use WHERE clause) | (none — use `WHERE scanner_type = '<type>' AND repo = '<repo>' AND status = 'running' ORDER BY started_at DESC LIMIT 1`) |

## Periodic heartbeat

During long-running phases (explore, implement, test, address-comments, architectural-review), re-run the UPDATE only (not the INSERT) every ~10 minutes to refresh `last_phase_at`:

```bash
sqlite3 {db_path} "
  UPDATE {table} SET last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'){extra_columns} WHERE {id_column} = '{id_value}';
"
```

You don't need to change `last_phase` — just refresh the timestamp.

## Reap thresholds

| Worker type | Stale after |
|-------------|------------|
| executor | 120 minutes |
| explorer | 120 minutes |
| reviewer | 60 minutes |
| ci-fix | 30 minutes |
| auditor | 30 minutes |
| docs | 30 minutes |
| DT scanner | 60 minutes |
