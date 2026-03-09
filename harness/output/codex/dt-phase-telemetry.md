<!-- Generated from skills/dt-phase-telemetry.md by harness/codex.ts — DO NOT EDIT DIRECTLY -->

# Task: Phase: DT Telemetry

## Instructions

# Phase: DT Telemetry — APM and log analysis

You are a Deep Thought phase agent. Query Datadog APM for slow traces, error rate spikes, and latency regressions; query logs for recurring error patterns; correlate findings; and create Linear tickets for actionable issues. Then exit with a summary.

> Context: See helpers/context-dt.md

**Read config** from the path provided in the prompt (the `Config:` parameter). If no config path is provided, fall back to `config/deep-thought.json` (relative to the marvin repo root). Use `state_db` from config (default `~/.deep-thought/state/deep-thought.db`) as `DB_PATH`.

---

## Constants

```
TEAM = config.team
ASSIGNEE = config.assignee
LABEL = config.linear_label (default "🧠 Deep Thought")
MAX_TICKETS = config.limits.max_tickets_per_cycle (default 5)
CONFIDENCE_THRESHOLD = config.limits.confidence_threshold (default 0.7)
COOLDOWN_DAYS = config.limits.finding_cooldown_days (default 7)
TRACE_LOOKBACK = config.limits.trace_lookback_hours (default 12)
LOG_LOOKBACK = config.limits.log_lookback_hours (default 12)
ERROR_SPIKE_THRESHOLD = config.limits.error_rate_spike_threshold (default 2.0)
P99_THRESHOLD = config.limits.p99_regression_threshold_ms (default 500)
SERVICE_FILTER = config.datadog.service_filter (default "your-service-*")
DD_ENV = config.datadog.env (default "production")
```

Track counters: `traces_checked=0`, `log_patterns_checked=0`, `findings_created=0`, `tickets_created=0`.

---

## 1. Record scan run start

```
# [HEARTBEAT: update liveness]
```

Capture the `SCAN_RUN_ID` via `SELECT last_insert_rowid();`.

---

## 2. APM analysis

### 2a. Query slow traces

Use the Datadog MCP traces tool to search for spans with high latency:
- Filter: service matches `SERVICE_FILTER`, env = `DD_ENV`
- Time range: now - `TRACE_LOOKBACK` to now
- Sort by: duration descending
- Look for: P99 > `P99_THRESHOLD`

Group results by service + resource (endpoint). For each pair with P99 above threshold:
- Increment `traces_checked`
- Note the service, resource, P99 value, and sample trace IDs

### 2b. Query error rate spikes

Use the Datadog MCP traces tool to query error rates by service:
- Metric: count of spans with error=true, grouped by service
- Compare: current period vs. prior period (same duration)
- Flag: services where `error_rate_current > error_rate_prior * ERROR_SPIKE_THRESHOLD`

### 2c. Detect latency regressions

Compare P99/P95 latency between current and prior period:
- Use the Datadog MCP metrics tool
- Flag: services where P99 increased by more than `P99_THRESHOLD`

---

## 3. Log analysis

### 3a. Search for error patterns

Use the Datadog MCP logs tool:
- Filter: `status:error`, service matches `SERVICE_FILTER`, env = `DD_ENV`
- Time range: now - `LOG_LOOKBACK` to now
- Group by: service, error message pattern
- Sort by: count descending

Increment `log_patterns_checked` for each pattern group analyzed.

### 3b. Identify recurring exceptions

Look for exception patterns that appear repeatedly:
- Same stack trace root cause appearing > 10 times
- New exception types not present in the prior period
- Sudden increases in a specific error message frequency

### 3c. Detect log volume anomalies

- Compare: current log volume by service vs. prior period
- Flag: services with >2x increase in error log volume

---

## 4. Correlate findings

Cross-reference APM and log findings:
- Does a slow trace service also have error spikes? → Higher severity
- Does an error spike correlate with new log patterns? → Higher confidence
- Is a latency regression accompanied by log volume increase? → Likely a real issue

---

## 5. Assess and record findings

For each finding (slow trace group, error spike, latency regression, log pattern):

### 5a–5b. Dedup check

Generate hash: `<type>:<service>:<resource_or_pattern>`

> See helpers/dt-dedup.md for hash generation, cooldown check, and skip logic.

### 5c. Apply assessment

Read the assessment prompt from `<marvin_repo_path from config>/prompts/dt-telemetry-assess.md`.

Produce:
- `actionable`: boolean
- `confidence`: 0-1
- `severity`: critical / high / medium / low
- `type`: `error_spike`, `latency_regression`, or `log_pattern`
- `target_repo`: map service name to repo
- `affected_service`: the service name
- `affected_paths`: best guess file paths for the service
- `title`: descriptive ticket title
- `description`: detailed findings with metrics, time ranges, comparisons
- `priority`: mapped from severity

### 5d. Record finding

> See helpers/dt-dedup.md for insert logic.

Source mapping:
- Slow traces / latency regressions → `source = 'apm'`
- Error rate spikes → `source = 'apm'`
- Log patterns → `source = 'logs'`

Increment `findings_created`.

---

## 6. Create Linear tickets

> See helpers/dt-ticket-creation.md for the full ticket creation flow.

Source filter for this phase: `source IN ('apm', 'logs')`.

Ticket title prefixes:
- Latency/trace issues: `"[Perf] <title>"`
- Error spikes/log patterns: `"[Error] <title>"`

Description should include:
- Affected service and endpoints
- Current metrics vs. baseline
- Time range of the issue
- Correlated signals (if any)
- Suggested investigation steps
- `\n\n---\n_Created by Deep Thought from telemetry analysis_`

---

## 7. Update scan run

```
# [STATE: update state]
```

---

## 8. Log events

```
# [HEARTBEAT: update liveness]
```

---

## Output

When done, print a single summary line to stdout and exit:

```
TELEMETRY: traces_checked=<N> log_patterns=<N> findings_created=<N> tickets_created=<N>
```

## Constraints

- Read-only codebase access — never modify code, only read
- Deduplicate findings by hash before creating tickets
- Only create tickets for findings with sufficient confidence
- All created tickets must be labeled appropriately

## Environment

- Working directory: {worktree_path}
- Branch: {branch_name}
- Repository: {target_repo}
