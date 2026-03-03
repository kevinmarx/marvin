# /dt-phase-codebase — Codebase scanning phase

You are a Deep Thought phase agent. Your job: spawn scanner teammates to analyze codebases for improvements (TODOs, stale dependencies, anti-patterns), collect their results, deduplicate against existing findings, and create Linear tickets for actionable issues. Then exit with a summary.

**Read config** from the path provided in the prompt (the `Config:` parameter). If no config path is provided, fall back to `config/deep-thought.json` (relative to the marvin repo root).

**Read DB path** from the `DB:` parameter in the prompt, falling back to `~/.deep-thought/state/deep-thought.db`.

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

## 1. Record scan run start

```bash
sqlite3 "$DB_PATH" "
  INSERT INTO scan_runs (cycle_number, phase, scanners_run)
  VALUES (
    (SELECT cycle_number FROM heartbeat WHERE id = 1),
    'codebase',
    0
  );
"
SCAN_RUN_ID=$(sqlite3 "$DB_PATH" "SELECT last_insert_rowid();")
```

## 1b. Check running scanners

Before spawning new scanners, check how many are already running (from a previous cycle that hasn't finished):

```bash
RUNNING_SCANNERS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM scanner_runs WHERE status = 'running';")
```

If `RUNNING_SCANNERS > 0`, log a warning and skip spawning new scanners for this cycle — the previous batch is still running:

```bash
CYCLE=$(sqlite3 "$DB_PATH" "SELECT cycle_number FROM heartbeat WHERE id = 1;")
sqlite3 "$DB_PATH" "
  INSERT INTO cycle_events (cycle_number, step, message)
  VALUES ($CYCLE, 'codebase_skip', 'Skipping scanner spawn: $RUNNING_SCANNERS scanners still running from previous cycle');
"
```

Skip directly to step 3 (collecting completed results) instead.

## 2. Spawn scanner teammates

For each repo in `config.repos`, spawn three scanner types. Each scanner writes results to a temp JSON file.

Generate unique result file paths:
```bash
TIMESTAMP=$(date +%s)
```

### Scanner spawning

For each repo in `config.repos` (iterating by name and path), spawn three scanners **in a single message** so they run in parallel:

**TODO scanner**:
- `subagent_type`: `"general-purpose"`
- `model`: `"opus"`
- `team_name`: `"deep-thought"`
- `mode`: `"bypassPermissions"`
- `name`: `"scan-todos-<repo_name>"` (e.g., `"scan-todos-your-main-repo"`)
- `run_in_background`: `true`
- `prompt`: `"Run /dt-scan-todos. Repo: <repo_name>. Path: <repo_path>. DB: <db_path>. Results file: /tmp/dt-scan-todos-<repo_name>-<timestamp>.json"`

Record the scanner run:
```bash
sqlite3 "$DB_PATH" "
  INSERT INTO scanner_runs (scanner_type, repo, cycle_number)
  VALUES ('todos', '<repo_name>', (SELECT cycle_number FROM heartbeat WHERE id = 1));
"
```

**Dependency scanner**:
- `name`: `"scan-deps-<repo_name>"`
- `prompt`: `"Run /dt-scan-deps. Repo: <repo_name>. Path: <repo_path>. DB: <db_path>. Results file: /tmp/dt-scan-deps-<repo_name>-<timestamp>.json"`

**Pattern scanner**:
- `name`: `"scan-patterns-<repo_name>"`
- `prompt`: `"Run /dt-scan-patterns. Repo: <repo_name>. Path: <repo_path>. DB: <db_path>. Results file: /tmp/dt-scan-patterns-<repo_name>-<timestamp>.json"`

Increment `scanners_spawned` for each scanner launched.

## 3. Wait for scanners to complete

Since scanners run in background, **do NOT wait for them**. Instead, check for results from scanners that have already completed (from previous cycles or fast-running current ones):

```bash
sqlite3 -json "$DB_PATH" "
  SELECT id, scanner_type, repo, results_file
  FROM scanner_runs
  WHERE status = 'completed'
    AND results_file IS NOT NULL
    AND id NOT IN (
      SELECT DISTINCT json_extract(datadog_context, '$.scanner_run_id')
      FROM findings
      WHERE json_extract(datadog_context, '$.scanner_run_id') IS NOT NULL
    );
"
```

For each completed scanner with unprocessed results:

### 3a. Read results file

```bash
# Read the JSON results file if it exists
cat /tmp/dt-scan-<type>-<repo>-<timestamp>.json
```

Each results file contains an array of findings:
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

Generate dedup hash:
```bash
DEDUP_HASH=$(echo -n "codebase:<type>:<repo>:<file_path>:<line_number_or_key>" | shasum -a 256 | awk '{print $1}')
```

Check for existing finding:
```bash
EXISTING=$(sqlite3 "$DB_PATH" "
  SELECT id FROM findings WHERE dedup_hash = '$DEDUP_HASH' LIMIT 1;
")
```

If no existing finding and confidence >= threshold:
```bash
SOURCE="codebase_<type>"  # e.g., codebase_todo, codebase_deps, codebase_pattern
sqlite3 "$DB_PATH" "
  INSERT INTO findings (source, type, dedup_hash, title, description, severity, confidence, target_repo, affected_paths, status, datadog_context, cooldown_until)
  VALUES ('$SOURCE', '<type>', '$DEDUP_HASH', '<title>', '<description>', '<severity>', <confidence>, '<repo>', '<paths_json>', 'new', json_object('scanner_run_id', <scanner_run_id>), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+$COOLDOWN_DAYS days'));
"
```

Increment `findings_created`.

## 4. Create Linear tickets

Check remaining ticket budget for this cycle:
```bash
ALREADY_CREATED=$(sqlite3 "$DB_PATH" "
  SELECT COALESCE(SUM(tickets_created), 0)
  FROM scan_runs
  WHERE cycle_number = (SELECT cycle_number FROM heartbeat WHERE id = 1)
    AND phase != 'codebase';
")
REMAINING=$((MAX_TICKETS - ALREADY_CREATED))
```

If `REMAINING <= 0`, skip ticket creation.

Query new codebase findings, prioritized by severity:
```bash
sqlite3 -json "$DB_PATH" "
  SELECT id, title, description, severity, confidence, target_repo, affected_paths, type, source
  FROM findings
  WHERE source LIKE 'codebase_%'
    AND status = 'new'
  ORDER BY
    CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END,
    confidence DESC
  LIMIT $REMAINING;
"
```

**Codebase findings are typically low priority** — use priority 4 (Low) unless severity is high.

For each finding, check Linear for duplicates first, then create:

a. **Create the ticket** via Linear MCP `create_issue`:
   - `title`: prefix based on type:
     - TODO findings: `"[Tech Debt] <title>"`
     - Stale deps: `"[Dependencies] <title>"`
     - Anti-patterns: `"[Code Quality] <title>"`
   - `team`: `"<TEAM from config>"`
   - `assignee`: `"<ASSIGNEE from config>"`
   - `labels`: `["🧠 Deep Thought"]`
   - `priority`: 4 (Low) for most codebase findings, 3 (Normal) for high severity
   - `description`: detailed findings including:
     - File paths and line numbers
     - Code context
     - Why this matters
     - Suggested fix approach
     - `\n\n---\n_Created by Deep Thought from codebase analysis_`

b. **Update finding** with ticket info (same pattern as other phases).

Increment `tickets_created`.

## 5. Clean up result files

Remove processed result files:
```bash
rm -f /tmp/dt-scan-*.json 2>/dev/null || true
```

## 6. Update scan run

```bash
sqlite3 "$DB_PATH" "
  UPDATE scan_runs
  SET scanners_run = $scanners_spawned,
      findings_created = $findings_created,
      tickets_created = $tickets_created,
      finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE id = $SCAN_RUN_ID;
"
```

## 7. Log events

```bash
CYCLE=$(sqlite3 "$DB_PATH" "SELECT cycle_number FROM heartbeat WHERE id = 1;")
sqlite3 "$DB_PATH" "
  INSERT INTO cycle_events (cycle_number, step, message)
  VALUES ($CYCLE, 'phase_codebase', 'CODEBASE: scanners=$scanners_spawned findings=$findings_created tickets=$tickets_created');
"
```

## Output

When done, print a single summary line to stdout and exit:

```
CODEBASE: scanners_spawned=<N> findings_created=<N> tickets_created=<N>
```

## Safety rules

- **Read-only codebase access** — never modify code
- **Creates tickets in Linear** — this is the core purpose
- All tickets get the `🧠 Deep Thought` label
- Respect `MAX_TICKETS` per cycle (shared across all phases)
- Never merge PRs
- Never deploy anything
