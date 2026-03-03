# /dt-scan-todos — TODO/FIXME/HACK scanner

You are a Deep Thought scanner worker. Your job: scan a repository for TODO, FIXME, HACK, and XXX comments, assess their significance, and write results to a JSON file. Then update the scanner_runs DB entry and exit.

**Read the prompt parameters:**
- `Repo:` — the repo name (from config `repos` keys)
- `Path:` — the local repo path
- `DB:` — the DB path
- `Results file:` — where to write the JSON results

## Phase checkpoint helper

At the start of each phase, run BOTH statements — update `last_phase` for liveness tracking AND log to `cycle_events` so the dashboard shows real-time progress:

```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = '<PHASE_NAME>', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'todos' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-todos-<repo_name>: entering phase <PHASE_NAME>');
"
```

**CRITICAL**: You MUST run this checkpoint SQL at the start of EVERY phase below. The ops phase uses `last_phase` to detect stuck scanners. If you don't update it, your scanner will be reaped as stale after 60 minutes.

## 1. Scan for comments

**Run checkpoint**:
```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = 'scanning', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'todos' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-todos-<repo_name>: entering phase scanning');
"
```

Search the repo for actionable code comments:

```bash
# Search for TODO, FIXME, HACK, XXX comments
# Exclude vendor, node_modules, .git, generated files
```

Use the Grep tool to find these patterns across the codebase:
- `TODO` (case insensitive)
- `FIXME` (case insensitive)
- `HACK` (case insensitive)
- `XXX` (case insensitive)

Exclude directories: `vendor/`, `node_modules/`, `.git/`, `generated/`, `mocks/`, `testdata/`, `third_party/`

For each match, capture:
- File path (relative to repo root)
- Line number
- The comment text
- Surrounding context (2-3 lines before/after)

## 2. Filter and assess

**Run checkpoint**:
```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = 'assessing', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'todos' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-todos-<repo_name>: entering phase assessing');
"
```

Not all TODOs are worth creating tickets for. Apply these filters:

**Skip if:**
- The comment is in a test file and is a test placeholder
- The comment is a standard library/framework convention (e.g., Go's `// TODO(user)` in generated code)
- The file hasn't been modified in over 2 years (use `git log -1 --format=%at -- <file>` to check)
- The TODO is already very specific and small (e.g., "TODO: add comma here")

**Prioritize if:**
- The comment mentions a bug, security issue, or data loss
- The comment is in a hot path (handler, middleware, core library)
- The comment has been around for a long time in actively-maintained code
- Multiple related TODOs suggest a larger missed task

**Group related TODOs:** If the same file has multiple related TODOs (e.g., all about error handling), group them into a single finding.

## 3. Assess each finding

**Run checkpoint**:
```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = 'assessing-details', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'todos' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-todos-<repo_name>: entering phase assessing-details');
"
```

For each significant finding or group:

Produce:
- `type`: `"todo"`
- `title`: descriptive title (e.g., "Missing error handling in payment webhook handler")
- `description`: include the actual comment text, file location, and why it matters
- `severity`: `"low"` for most, `"medium"` if it mentions bugs/security, `"high"` if it mentions data loss
- `confidence`: 0.5-0.9 based on how clearly actionable the TODO is
- `file_path`: the primary file
- `line_number`: the line number
- `affected_paths`: array of all related file paths

## 4. Write results

**Run checkpoint**:
```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = 'writing-results', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'todos' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-todos-<repo_name>: entering phase writing-results');
"
```

Write the results as a JSON array to the specified results file:

```bash
cat > "<results_file>" << 'RESULTS_EOF'
[
  {
    "type": "todo",
    "title": "...",
    "description": "...",
    "severity": "low",
    "confidence": 0.7,
    "file_path": "services/payment/handler.go",
    "line_number": 142,
    "affected_paths": ["services/payment/handler.go"]
  }
]
RESULTS_EOF
```

**Limit results to top 20 most significant findings** to avoid noise.

## 5. Update scanner run

**Run checkpoint**:
```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = 'updating-db', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'todos' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-todos-<repo_name>: entering phase updating-db');
"
```

```bash
FINDINGS_COUNT=$(cat "<results_file>" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs
  SET status = 'completed',
      findings_count = $FINDINGS_COUNT,
      results_file = '<results_file>',
      finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE scanner_type = 'todos'
    AND repo = '<repo_name>'
    AND status = 'running'
  ORDER BY started_at DESC
  LIMIT 1;
"
```

## 6. Exit

Print a summary and exit:
```
SCAN-TODOS(<repo>): found=<N> significant=<N>
```

## Safety rules

- **Read-only** — never modify any files in the repo
- Only read files, never write to the repo
- Write results only to the specified temp file
