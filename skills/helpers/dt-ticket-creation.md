# Ticket creation from findings

All DT phases share this pattern for creating Linear tickets from findings.

## 1. Check ticket budget

The `MAX_TICKETS` limit is shared across all phases in a cycle. Before creating tickets, check how many have already been created:

```sql
SELECT COALESCE(SUM(tickets_created), 0)
FROM scan_runs
WHERE cycle_number = (SELECT cycle_number FROM heartbeat WHERE id = 1)
  AND phase != '<current_phase>';
```

If `MAX_TICKETS - already_created <= 0`, skip ticket creation entirely.

## 2. Query new findings

Fetch findings prioritized by severity, then confidence:

```sql
SELECT id, title, description, severity, confidence, target_repo, affected_service, affected_paths, type
FROM findings
WHERE source IN (<source_filter>)
  AND status = 'new'
ORDER BY
  CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END,
  confidence DESC
LIMIT <remaining_budget>;
```

## 3. Check Linear for duplicates

Before creating each ticket, search Linear for existing open tickets with similar titles:

```
Linear MCP list_issues:
  query: <keywords from finding title>
  team: <TEAM from config>
  state: NOT in (Done, Cancelled)
```

If a similar ticket exists, mark finding as `deduped` instead of creating a ticket.

## 4. Create the ticket

Via Linear MCP `save_issue`:

- `title`: Prefixed by source type:
  - Alerts: `"[Alert] <title>"`
  - Latency/traces: `"[Perf] <title>"`
  - Error spikes/log patterns: `"[Error] <title>"`
  - TODO findings: `"[Tech Debt] <title>"`
  - Stale deps: `"[Dependencies] <title>"`
  - Anti-patterns: `"[Code Quality] <title>"`
- `team`: `<TEAM from config>`
- `assignee`: `<ASSIGNEE from config>`
- `labels`: `["🧠 Deep Thought"]` (or `linear_label` from config)
- `priority`: Mapped from severity — critical=1, high=2, medium=3, low=4
- `description`: Detailed findings with context, ending with:
  ```
  \n\n---\n_Created by Deep Thought from <source description>_
  ```

## 5. Update finding with ticket info

```sql
UPDATE findings
SET status = 'ticket_created',
    ticket_linear_id = '<linear_id>',
    ticket_identifier = '<identifier>',
    ticket_url = '<url>',
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = <finding_id>;
```
