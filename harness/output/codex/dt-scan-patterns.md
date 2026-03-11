<!-- Generated from skills/dt-scan-patterns.md by harness/codex.ts — DO NOT EDIT DIRECTLY -->

# Task: Scanner: Anti-pattern detector

## Instructions

# Scanner: Anti-pattern detector

You are a Deep Thought scanner worker. Scan a repository for known anti-patterns and code quality issues, assess their significance, and write results to a JSON file. Then update the scanner_runs DB entry and exit.

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
- ID match: `WHERE scanner_type = 'patterns' AND repo = '<repo_name>' AND status = 'running' ORDER BY started_at DESC LIMIT 1`
- Identifier: `scan-patterns-<repo_name>`

**CRITICAL**: You MUST run the checkpoint SQL at the start of EVERY phase below. The ops phase uses `last_phase` to detect stuck scanners. If you don't checkpoint, your scanner will be reaped as stale after 60 minutes.

---

## 1. Read repo conventions

**Checkpoint**: `reading-conventions`

Check for a `.claude/CLAUDE.md` in the repo to understand existing conventions and coding standards. This tells you what the team considers correct, so you can flag deviations.

---

## 2. Scan for anti-patterns

**Checkpoint**: `scanning`

Search the codebase for known problematic patterns. Adjust based on the languages present in the repo:

### Go anti-patterns

- **Ignored errors**: `_ = someFunc()` or missing error checks after calls that return errors
- **Unbounded queries**: SQL queries without `LIMIT` in contexts where results could be large
- **Missing context propagation**: HTTP handlers or gRPC methods that use `context.Background()` instead of the request context
- **Hardcoded credentials**: strings that look like API keys, passwords, or secrets (not in test files)
- **Mutex misuse**: `sync.Mutex` without corresponding `Unlock()` (or `defer mu.Unlock()`)
- **Goroutine leaks**: goroutines launched without cancellation context or done channel
- **Panic in library code**: `panic()` used outside of `main()` or `init()` (should return errors instead)
- **Large functions**: Functions with > 100 lines that could be decomposed

### Node.js/TypeScript anti-patterns

- **Unhandled promise rejections**: `.then()` without `.catch()`, or async functions without try/catch
- **Callback hell**: deeply nested callbacks (> 3 levels)
- **Synchronous file I/O**: `fs.readFileSync` or similar in request handlers
- **Missing input validation**: Express/Koa handlers that access `req.body.*` without validation
- **Hardcoded credentials**: same as Go
- **Console.log in production code**: `console.log` outside of test/debug files

### Ruby anti-patterns

- **N+1 queries**: ActiveRecord patterns that suggest N+1 (`.each` followed by association access without `includes`)
- **Unscoped queries**: `Model.all` or `Model.where()` without limits in non-admin contexts
- **Missing error handling**: `rescue` without specifying exception class (bare rescue)
- **Hardcoded credentials**: same as above
- **Thread safety**: shared mutable state without synchronization

### Universal anti-patterns

- **SQL injection**: string interpolation in SQL queries (not using parameterized queries)
- **Large file uploads**: handling without size limits
- **Missing timeouts**: HTTP client calls without timeout configuration
- **Retry without backoff**: retry loops without exponential backoff
- **Logging sensitive data**: logging that might include passwords, tokens, PII

---

## 3. Grep-based scanning

**Checkpoint**: `grep-scanning`

Use the Grep tool strategically. Don't try to scan everything — focus on high-signal patterns:

```
# Go: ignored errors
pattern: `_ = \w+\(` in *.go files (exclude test files)

# Go: missing context
pattern: `context\.Background\(\)` in handler/middleware files

# Go: unbounded queries
pattern: `SELECT .* FROM` without LIMIT (in non-count queries)

# Universal: hardcoded secrets
pattern: `(password|secret|api_key|token)\s*[:=]\s*["']` (case insensitive, exclude test files)

# Universal: SQL injection
pattern: `fmt\.Sprintf.*SELECT|"SELECT.*" \+` or string interpolation in SQL
```

**Be selective**: only scan directories that contain application code. Skip:
- `vendor/`, `node_modules/`, `.git/`
- `*_test.go`, `*_spec.rb`, `*.test.ts`, `*.spec.ts`
- `testdata/`, `fixtures/`, `mocks/`
- Generated code, protobuf output

---

## 4. Assess findings

**Checkpoint**: `assessing`

For each pattern match:

**False positive filtering:**
- Check surrounding context (5 lines before/after) — is there a comment explaining the pattern?
- Is it in dead/deprecated code?
- Is the pattern intentional (e.g., `_ = f.Close()` is often acceptable)?

**Severity assessment:**
- `"high"`: security issues (SQL injection, hardcoded secrets, missing auth)
- `"medium"`: reliability issues (missing error handling, unbounded queries, goroutine leaks)
- `"low"`: code quality (large functions, missing timeouts, style issues)

**Confidence assessment:**
- 0.9: clear anti-pattern with no ambiguity (SQL injection, hardcoded secret)
- 0.7-0.8: likely anti-pattern, context suggests it's problematic
- 0.5-0.6: possible anti-pattern, but context is unclear

**Group related findings**: if the same anti-pattern appears in multiple files of the same service, group them.

---

## 5. Write results

**Checkpoint**: `writing-results`

Write the results as a JSON array to the specified results file.

**Limit results to top 15 most significant findings** — prioritize security > reliability > code quality.

```bash
cat > "<results_file>" << 'RESULTS_EOF'
[
  {
    "type": "anti_pattern",
    "title": "SQL injection risk in user search endpoint",
    "description": "String interpolation used in SQL query at services/users/search.go:87:\n\n```go\nquery := fmt.Sprintf(\"SELECT * FROM users WHERE name = '%s'\", name)\n```\n\nThis is vulnerable to SQL injection. Use parameterized queries instead:\n```go\nquery := \"SELECT * FROM users WHERE name = $1\"\nrows, err := db.Query(query, name)\n```",
    "severity": "high",
    "confidence": 0.9,
    "file_path": "services/users/search.go",
    "line_number": 87,
    "affected_paths": ["services/users/search.go"]
  }
]
RESULTS_EOF
```

---

## 6. Update scanner run

**Checkpoint**: `updating-db`

```bash
FINDINGS_COUNT=$(cat "<results_file>" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
```

```
# [STATE: update state]
```

---

## 7. Exit

Print a summary and exit:
```
SCAN-PATTERNS(<repo>): patterns_checked=<N> findings=<N>
```

## Safety rules

- **Read-only** — never modify any files in the repo
- Only read files, never write to the repo
- Write results only to the specified temp file
- Never execute code from the repo
- Never run tests or builds

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
