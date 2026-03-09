# Orchestrator heartbeat refresh (for phase agents)

Phase agents are short-lived but can run for 10+ minutes during heavy work (especially phase-pr polling 40+ PRs). The orchestrator can't update its own heartbeat while waiting for a phase to complete. To keep the dashboard from showing "not responding", phase agents should refresh the heartbeat periodically.

## When to refresh

Run this SQL **before each major numbered step** in the phase (e.g., before step 1, before step 2, etc.). This ensures the heartbeat stays fresh even during long phases.

## SQL

```sql
UPDATE heartbeat SET
  last_beat_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 1;
```

**Important**: Only update `last_beat_at`. Do NOT change `current_step` or `cycle_number` — those are owned by the orchestrator.
