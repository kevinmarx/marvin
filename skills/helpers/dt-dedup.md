# Finding deduplication pattern

All DT phases (alerts, telemetry, codebase) deduplicate findings before insertion. This pattern prevents duplicate tickets for the same issue.

## Hash computation

Generate a SHA-256 hash from the finding's source, type, and key identifier:

```bash
DEDUP_HASH=$(echo -n "<source>:<type>:<unique_key>" | shasum -a 256 | awk '{print $1}')
```

### Hash key formats by source

| Source | Hash input | Example |
|--------|-----------|---------|
| Alert (monitor) | `alert:<monitor_id>:<monitor_name>` | `alert:12345:High CPU on web` |
| Alert (pattern) | `pattern:<pattern_type>:<sorted_monitor_ids>` | `pattern:chronic_alert:12345,67890` |
| APM / Logs | `<type>:<service>:<resource_or_pattern>` | `error_spike:api-gateway:POST /orders` |
| Codebase | `codebase:<type>:<repo>:<file_path>:<line_or_key>` | `codebase:todo:main-repo:handler.go:142` |

## Cooldown check

Query existing findings by hash and skip if any of these conditions are true:

```sql
SELECT id, status, cooldown_until
FROM findings
WHERE dedup_hash = '<hash>'
LIMIT 1;
```

**Skip if:**
- `status = 'ticket_created'` — ticket already open
- `cooldown_until > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` — in cooldown period
- `status = 'resolved'` AND `resolved_at` is within `COOLDOWN_DAYS`

## Insert finding

If no existing finding or past cooldown, insert:

```sql
INSERT INTO findings (
  source, type, dedup_hash, title, description, severity, confidence,
  target_repo, affected_paths, affected_service, status,
  datadog_monitor_id, datadog_context, cooldown_until
)
VALUES (
  '<source>', '<type>', '<hash>', '<title>', '<description>',
  '<severity>', <confidence>, '<target_repo>', '<paths_json>',
  '<affected_service>', 'new', '<monitor_id_or_null>',
  '<context_json>', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+<COOLDOWN_DAYS> days')
);
```

If not actionable or below confidence threshold, record as skipped (with short cooldown to avoid re-evaluating every cycle):

```sql
INSERT OR IGNORE INTO findings (
  source, type, dedup_hash, title, description, severity, confidence,
  status, skip_reason, datadog_monitor_id,
  cooldown_until
)
VALUES (
  '<source>', '<type>', '<hash>', '<title>', '<brief_note>',
  '<severity>', <confidence>, 'skipped', '<reason>',
  '<monitor_id_or_null>',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 days')
);
```
