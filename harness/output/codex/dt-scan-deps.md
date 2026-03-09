<!-- Generated from skills/dt-scan-deps.md by harness/codex.ts — DO NOT EDIT DIRECTLY -->

# Task: Scanner: Dependency staleness

## Instructions

# Scanner: Dependency staleness

You are a Deep Thought scanner worker. Scan a repository for stale or outdated dependencies, assess their risk, and write results to a JSON file. Then update the scanner_runs DB entry and exit.

> Context: See helpers/context-dt.md

## Inputs

- `Repo:` — the repo name (from config `repos` keys)
- `Path:` — the local repo path
- `DB:` — the DB path
- `Results file:` — where to write the JSON results

## Phase checkpoints

> Track progress by logging phase transitions.
Scanner checkpoint table variant:
- Table: `scanner_runs`
- ID match: `WHERE scanner_type = 'deps' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1`
- Identifier: `scan-deps-<repo_name>`

**CRITICAL**: You MUST run the checkpoint SQL at the start of EVERY phase below. The ops phase uses `last_phase` to detect stuck scanners. If you don't checkpoint, your scanner will be reaped as stale after 60 minutes.

---

## 1. Find dependency files

**Checkpoint**: `scanning`

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

---

## 2. Analyze dependencies

**Checkpoint**: `analyzing`

For each dependency file found:

### Go modules
Read `go.mod` and identify:
- Modules with versions that are 2+ major versions behind
- Modules with dates more than 6 months old
- Known deprecated modules
- Modules with known security advisories

### Node.js packages
Read `package.json` and identify:
- Packages with pinned versions that are very old
- Packages with known deprecation notices
- Large major version gaps (e.g., using v2 when v5 is available)

### Ruby gems
Read `Gemfile` and identify:
- Gems pinned to very old versions
- Gems that haven't been updated in the lockfile for extended periods

---

## 3. Group findings

**Checkpoint**: `grouping`

Group related stale dependencies by service/directory. A single finding might cover:
- "services/chat has 5 stale Go dependencies"
- "web-client has outdated React dependencies"

For each group, produce:
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

---

## 4. Write results

**Checkpoint**: `writing-results`

Write the results as a JSON array to the specified results file.

**Limit results to top 10 most significant findings.**

```bash
cat > "<results_file>" << 'RESULTS_EOF'
[
  {
    "type": "stale_dep",
    "title": "Stale Go dependencies in chat service",
    "description": "...",
    "severity": "medium",
    "confidence": 0.8,
    "file_path": "services/chat/go.mod",
    "line_number": 0,
    "affected_paths": ["services/chat/go.mod", "services/chat/go.sum"]
  }
]
RESULTS_EOF
```

---

## 5. Update scanner run

**Checkpoint**: `updating-db`

```bash
FINDINGS_COUNT=$(cat "<results_file>" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
```

```
# [STATE: update state]
```

---

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

## Constraints

- Read-only codebase access — never modify code, only read
- Deduplicate findings by hash before creating tickets
- Only create tickets for findings with sufficient confidence
- All created tickets must be labeled appropriately
- Write results to the designated JSON file only
- Update scanner_runs DB entry on completion

## Environment

- Working directory: {worktree_path}
- Branch: {branch_name}
- Repository: {target_repo}
