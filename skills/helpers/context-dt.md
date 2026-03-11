# Context: Deep Thought

Deep Thought is an autonomous observability and codebase analysis system. It continuously scans Datadog alerts, APM traces, log patterns, and codebases to proactively identify issues and create Linear tickets for Marvin to execute.

**Key difference from Marvin**: Deep Thought **creates** tickets in Linear (Marvin only consumes them). Deep Thought is **read-only** on codebases (Marvin modifies them). They form a proactive-reactive pipeline: Deep Thought finds problems → creates tickets → Marvin picks them up and fixes them.

## Safety invariants

- **Read-only codebase access** — never modifies code, only reads
- **Deduplication** — findings are deduped by hash before ticket creation
- **Rate limiting** — max 5 tickets per cycle (configurable via `limits.max_tickets_per_cycle`)
- **Confidence threshold** — only creates tickets for findings with confidence ≥ 0.7 (configurable via `limits.confidence_threshold`)
- **Cooldown** — won't re-create tickets for the same finding within 7 days (configurable via `limits.finding_cooldown_days`)
- **Labeling** — all created tickets get the `🧠 Deep Thought` label (configurable via `linear_label`)
- All tickets created on the configured team, assigned to the configured assignee
- Never merge PRs
- Never deploy anything
- Never modify any repository

## State management

- SQLite database at `~/.deep-thought/state/deep-thought.db` (configurable via `state_db`)
- Schema managed via numbered migrations in `schema/dt-migrations/` — run `scripts/dt-migrate.sh`
- All timestamps use `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` — never `datetime('now')`

### Database tables

| Table | Purpose |
|-------|---------|
| `findings` | Core finding tracking — source, type, severity, confidence, dedup hash, ticket link, cooldown |
| `scan_runs` | Per-cycle stats per phase (alerts checked, traces checked, findings created, tickets created) |
| `heartbeat` | Singleton row: orchestrator liveness (cycle number, current step, last beat) |
| `cycle_events` | Per-cycle event log for dashboard activity |
| `scanner_runs` | Codebase scanner attempt tracking (type, repo, status, results file, last_phase, last_phase_at) |
| `schema_version` | Tracks applied migrations |

## Configuration

Config in `config/deep-thought.json` (env var `DEEP_THOUGHT_CONFIG` overrides). Key fields:

| Field | Default | Purpose |
|-------|---------|---------|
| `team` | — | Linear team name |
| `assignee` | — | Linear assignee for created tickets |
| `repos` | — | Map of repo name → local path |
| `state_db` | `~/.deep-thought/state/deep-thought.db` | SQLite database path |
| `linear_label` | `🧠 Deep Thought` | Label applied to all created tickets |
| `cycle_interval_seconds` | `21600` (6h) | Sleep between cycles |
| `self_restart_after_cycles` | `4` | Exit cleanly after N cycles (~24h) |
| `limits.max_tickets_per_cycle` | `5` | Rate limit on ticket creation |
| `limits.confidence_threshold` | `0.7` | Minimum confidence to create a ticket |
| `limits.finding_cooldown_days` | `7` | Cooldown before re-creating same finding |
| `limits.stale_scanner_minutes` | `60` | Timeout for scanner workers |
| `limits.alert_lookback_hours` | `12` | How far back to poll alerts |
| `limits.trace_lookback_hours` | `12` | How far back to query traces |
| `limits.log_lookback_hours` | `12` | How far back to query logs |
| `limits.error_rate_spike_threshold` | `2.0` | Multiplier to flag error rate spikes |
| `limits.p99_regression_threshold_ms` | `500` | P99 increase to flag regression |
| `datadog.monitor_tags` | `["team:your-team"]` | Tags to filter monitors |
| `datadog.service_filter` | `your-service-*` | Service name filter for APM/logs |
| `datadog.env` | `production` | Datadog environment |

## Worker types

| Role | Spawned by | What it does |
|------|-----------|--------------|
| TODO scanner | phase-codebase | Grep TODOs → assess significance → write JSON |
| Deps scanner | phase-codebase | Find manifests → analyze staleness → write JSON |
| Pattern scanner | phase-codebase | Grep anti-patterns → assess false positives → write JSON |
