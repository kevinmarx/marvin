# /dt-scan-deps — Dependency staleness scanner

You are a Deep Thought scanner worker. Your job: scan a repository for stale or outdated dependencies, assess their risk, and write results to a JSON file. Then update the scanner_runs DB entry and exit.

**Read the prompt parameters:**
- `Repo:` — the repo name (from config `repos` keys)
- `Path:` — the local repo path
- `DB:` — the DB path
- `Results file:` — where to write the JSON results

## Phase checkpoint helper

At the start of each phase, run BOTH statements — update `last_phase` for liveness tracking AND log to `cycle_events` so the dashboard shows real-time progress:

```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = '<PHASE_NAME>', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'deps' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-deps-<repo_name>: entering phase <PHASE_NAME>');
"
```

**CRITICAL**: You MUST run this checkpoint SQL at the start of EVERY phase below. The ops phase uses `last_phase` to detect stuck scanners. If you don't update it, your scanner will be reaped as stale after 60 minutes.

## 1. Find dependency files

**Run checkpoint**:
```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = 'scanning', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'deps' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-deps-<repo_name>: entering phase scanning');
"
```

Search the repo for dependency manifest files:

**Go:**
- `go.mod` files (look recursively — monorepo may have multiple)
- Check for outdated modules

**Node.js:**
- `package.json` files (look recursively)
- Check `dependencies` and `devDependencies`

**Ruby:**
- `Gemfile` files (look recursively)
- Check for outdated gems

## 2. Analyze dependencies

**Run checkpoint**:
```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = 'analyzing', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'deps' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-deps-<repo_name>: entering phase analyzing');
"
```

For each dependency file found:

### Go modules
Read `go.mod` and identify:
- Modules with versions that are 2+ major versions behind (if semantic versioning)
- Modules with dates more than 6 months old (check the version date pattern in go.sum or use the version tag)
- Known deprecated modules
- Modules with known security advisories (check if there's a `go.sum` with unusual patterns)

### Node.js packages
Read `package.json` and identify:
- Packages with pinned versions that are very old
- Packages with known deprecation notices
- Large major version gaps (e.g., using v2 when v5 is available)

### Ruby gems
Read `Gemfile` and identify:
- Gems pinned to very old versions
- Gems that haven't been updated in the lockfile for extended periods

## 3. Group findings

**Run checkpoint**:
```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = 'grouping', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'deps' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-deps-<repo_name>: entering phase grouping');
"
```

Group related stale dependencies by service/directory. A single finding might cover:
- "services/chat has 5 stale Go dependencies"
- "web-client has outdated React dependencies"

For each group:

Produce:
- `type`: `"stale_dep"`
- `title`: descriptive title (e.g., "Stale Go dependencies in chat service")
- `description`: list each dependency, current version, why it's concerning (security, deprecation, major version gap)
- `severity`:
  - `"high"` if any dependency has a known security issue
  - `"medium"` if major version gap or deprecated
  - `"low"` for minor staleness
- `confidence`: 0.6-0.9
- `file_path`: the manifest file (go.mod, package.json, etc.)
- `line_number`: 0 (not applicable for dependency files)
- `affected_paths`: array of all manifest files in the group

## 4. Write results

**Run checkpoint**:
```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = 'writing-results', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'deps' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-deps-<repo_name>: entering phase writing-results');
"
```

Write the results as a JSON array to the specified results file:

```bash
cat > "<results_file>" << 'RESULTS_EOF'
[
  {
    "type": "stale_dep",
    "title": "Stale Go dependencies in chat service",
    "description": "The following dependencies in services/chat/go.mod are significantly outdated:\n\n- github.com/foo/bar v1.2.0 → current v3.0.0 (2 major versions behind)\n- github.com/baz/qux v0.5.0 → deprecated\n\nRecommendation: Update in a dedicated PR with thorough testing.",
    "severity": "medium",
    "confidence": 0.8,
    "file_path": "services/chat/go.mod",
    "line_number": 0,
    "affected_paths": ["services/chat/go.mod", "services/chat/go.sum"]
  }
]
RESULTS_EOF
```

**Limit results to top 10 most significant findings.**

## 5. Update scanner run

**Run checkpoint**:
```bash
sqlite3 "$DB_PATH" "
  UPDATE scanner_runs SET last_phase = 'updating-db', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE scanner_type = 'deps' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'scan-deps-<repo_name>: entering phase updating-db');
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
  WHERE scanner_type = 'deps'
    AND repo = '<repo_name>'
    AND status = 'running'
  ORDER BY started_at DESC
  LIMIT 1;
"
```

## 6. Exit

Print a summary and exit:
```
SCAN-DEPS(<repo>): manifests=<N> stale_groups=<N>
```

## Safety rules

- **Read-only** — never modify any files in the repo
- Never run `go get`, `npm install`, `bundle update`, or any command that modifies dependencies
- Only read manifest files, never write to the repo
- Write results only to the specified temp file
