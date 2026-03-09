# Phase: DT Codebase — Scanner orchestration

You are a Deep Thought phase agent. Spawn scanner teammates to analyze codebases for improvements (TODOs, stale dependencies, anti-patterns), collect their results, deduplicate against existing findings, and create Linear tickets for actionable issues. Then exit with a summary.

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
REPOS = config.repos (map of repo name → local path)
```

Track counters: `scanners_spawned=0`, `findings_created=0`, `tickets_created=0`.

---

## 1. Record scan run start

```sql
INSERT INTO scan_runs (cycle_number, phase, scanners_run)
VALUES (
  (SELECT cycle_number FROM heartbeat WHERE id = 1),
  'codebase',
  0
);
```

Capture the `SCAN_RUN_ID` via `SELECT last_insert_rowid();`.

---

## 1b. Check running scanners

Before spawning new scanners, check how many are already running:

```sql
SELECT COUNT(*) FROM scanner_runs WHERE status = 'running';
```

If `> 0`, log a warning and skip to step 3 (collecting completed results):

```sql
INSERT INTO cycle_events (cycle_number, step, message)
VALUES (
  (SELECT cycle_number FROM heartbeat WHERE id = 1),
  'codebase_skip',
  'Skipping scanner spawn: <N> scanners still running from previous cycle'
);
```

---

## 2. Spawn scanner teammates

For each repo in `config.repos`, spawn three scanner types. Generate unique result file paths:
```bash
TIMESTAMP=$(date +%s)
```

For each repo (iterating by name and path), spawn three scanners **in a single message** so they run in parallel:

**TODO scanner**:
- `name`: `"scan-todos-<repo_name>"`
- `run_in_background`: `true`
- `prompt`: `"Run /dt-scan-todos. Repo: <repo_name>. Path: <repo_path>. DB: <db_path>. Results file: /tmp/dt-scan-todos-<repo_name>-<timestamp>.json"`

Record the scanner run:
```sql
INSERT INTO scanner_runs (scanner_type, repo, cycle_number)
VALUES ('todos', '<repo_name>', (SELECT cycle_number FROM heartbeat WHERE id = 1));
```

**Dependency scanner**:
- `name`: `"scan-deps-<repo_name>"`
- `prompt`: `"Run /dt-scan-deps. Repo: <repo_name>. Path: <repo_path>. DB: <db_path>. Results file: /tmp/dt-scan-deps-<repo_name>-<timestamp>.json"`

**Pattern scanner**:
- `name`: `"scan-patterns-<repo_name>"`
- `prompt`: `"Run /dt-scan-patterns. Repo: <repo_name>. Path: <repo_path>. DB: <db_path>. Results file: /tmp/dt-scan-patterns-<repo_name>-<timestamp>.json"`

All spawned with: `subagent_type: "general-purpose"`, `model: "opus"`, `team_name: "deep-thought"`, `mode: "bypassPermissions"`.

Record scanner runs for deps and patterns too. Increment `scanners_spawned` for each scanner launched.

---

## 3. Collect completed scanner results

Since scanners run in background, **do NOT wait for them**. Check for results from already-completed scanners:

```sql
SELECT id, scanner_type, repo, results_file
FROM scanner_runs
WHERE status = 'completed'
  AND results_file IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT json_extract(datadog_context, '$.scanner_run_id')
    FROM findings
    WHERE json_extract(datadog_context, '$.scanner_run_id') IS NOT NULL
  );
```

For each completed scanner with unprocessed results:

### 3a. Read results file

Read the JSON results file. Each file contains an array of findings:
```json
[
  {
    "type": "todo|stale_dep|anti_pattern",
    "title": "Short description",
    "description": "Detailed description with context",
    "severity": "low|medium|high",
    "confidence": 0.8,
    "file_path": "path/to/file",
    "line_number": 42,
    "affected_paths": ["path1", "path2"]
  }
]
```

### 3b. Deduplicate and record findings

For each result from the scanner:

Generate hash: `codebase:<type>:<repo>:<file_path>:<line_number_or_key>`

> See helpers/dt-dedup.md for dedup check and insert logic.

Source format: `codebase_<type>` (e.g., `codebase_todo`, `codebase_deps`, `codebase_pattern`).

Include `scanner_run_id` in `datadog_context`:
```sql
json_object('scanner_run_id', <scanner_run_id>)
```

Increment `findings_created`.

---

## 4. Create Linear tickets

> See helpers/dt-ticket-creation.md for the full ticket creation flow.

Source filter for this phase: `source LIKE 'codebase_%'`.

**Codebase findings are typically low priority** — use priority 4 (Low) unless severity is high.

Ticket title prefixes by type:
- TODO findings: `"[Tech Debt] <title>"`
- Stale deps: `"[Dependencies] <title>"`
- Anti-patterns: `"[Code Quality] <title>"`

Description should include:
- File paths and line numbers
- Code context
- Why this matters
- Suggested fix approach
- `\n\n---\n_Created by Deep Thought from codebase analysis_`

---

## 5. Clean up result files

```bash
rm -f /tmp/dt-scan-*.json 2>/dev/null || true
```

---

## 6. Update scan run

```sql
UPDATE scan_runs
SET scanners_run = <scanners_spawned>,
    findings_created = <findings_created>,
    tickets_created = <tickets_created>,
    finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = <SCAN_RUN_ID>;
```

---

## 7. Log events

```sql
INSERT INTO cycle_events (cycle_number, step, message)
VALUES (
  (SELECT cycle_number FROM heartbeat WHERE id = 1),
  'phase_codebase',
  'CODEBASE: scanners=<N> findings=<N> tickets=<N>'
);
```

---

## Output

When done, print a single summary line to stdout and exit:

```
CODEBASE: scanners_spawned=<N> findings_created=<N> tickets_created=<N>
```
