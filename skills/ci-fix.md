# CI Fix — fix CI failures on a PR

CI-fixer teammate: investigate CI failures, make targeted fixes, run tests locally, and push a fix commit.

> Context: See helpers/context-worker.md

## Inputs

- `pr_number`: GitHub PR number
- `repo`: full repo name (e.g. `<github_org>/<target_repo>`)
- `target_repo`: short repo name (from config `repos` keys)
- `worktree_path`: absolute path to the worktree
- `branch_name`: git branch name
- `repo_path`: absolute path to the main repo
- `ci_fix_run_id`: row ID in `ci_fix_runs` table
- `head_sha`: current HEAD commit SHA

## Workflow

### Phase 1: Sync worktree

> See helpers/phase-checkpoint.md — table: `ci_fix_runs`, role: `ci-fix`
> See helpers/branch-safety.md

```bash
cd <worktree_path>
git fetch origin <branch_name>
git pull origin <branch_name>
```

### Phase 2: Investigate CI failure

1. **Fetch failed check runs**:
```bash
gh api repos/<repo>/commits/<head_sha>/check-runs --jq '.check_runs[] | select(.conclusion=="failure") | {id, name, status, conclusion}'
```

2. **Fetch annotations** for each failed check:
```bash
gh api repos/<repo>/check-runs/<check_run_id>/annotations
```

3. **Fetch Actions job logs** for deeper context:
```bash
gh api repos/<repo>/actions/runs --jq '.workflow_runs[] | select(.head_sha=="<head_sha>" and .conclusion=="failure") | .id' | head -5
```
Then for each run:
```bash
gh api repos/<repo>/actions/runs/<run_id>/jobs --jq '.jobs[] | select(.conclusion=="failure") | {id, name, steps: [.steps[] | select(.conclusion=="failure")]}'
gh api repos/<repo>/actions/jobs/<job_id>/logs 2>/dev/null | tail -200
```

4. **Categorize the failure**:

| Type | What it means |
|------|---------------|
| `test_failure` | Test assertions failing, test compilation errors |
| `lint_error` | Linter violations, formatting issues |
| `build_error` | Compilation failures, dependency issues |
| `unknown` | Can't determine from logs |

5. **Stop conditions** — mark run as failed and exit if:
   - Categorized as `unknown` and logs are unparseable
   - Failure is in **infrastructure/CI config** (GitHub Actions YAML, CI runner issues, network timeouts, Docker image pulls)

### Phase 3: Fix + test

1. Read the repo's `.claude/CLAUDE.md` for conventions
2. Read the failing files identified from annotations/logs
3. **Make targeted fixes** — only address the CI failure:
   - Test failures: fix the test or the code it tests
   - Lint errors: apply required formatting/style fixes
   - Build errors: fix compilation issues, missing imports, type errors

4. **Scope limit**: maximum **5 files** changed per fix attempt. If more are needed → mark failed with "Fix requires changes to more than 5 files, needs manual attention."

5. **Run tests locally**:
   - Go: `cd <worktree_path>/<app_dir> && go test ./...`
   - Ruby: `cd <worktree_path>/<app_dir> && bundle exec rspec`
   - Node: `cd <worktree_path>/<app_dir> && npm test`
   - Terraform: `cd <worktree_path> && terraform fmt -check && terraform validate`

6. **Flaky test detection**: If the test passes locally but failed in CI → do NOT change code. Mark failed with `failure_type = 'test_failure'` and error "Test passes locally but failed in CI — likely flaky. Not changing code."

### Phase 4: Commit and push

> See helpers/branch-safety.md — re-check before committing

1. **Stage specific files** (never use `git add -A`):
```bash
git add <file1> <file2> ...
```

2. **Commit**:
```bash
git commit -m "$(cat <<'EOF'
Fix CI failure: <brief description>

<failure_type>: <details of what was wrong and what was fixed>

Co-Authored-By: Marvin (Claude Code) <noreply@anthropic.com>
EOF
)"
```

3. **Push** (explicit refspec, never force-push):
```bash
git push origin HEAD:refs/heads/<branch_name>
```

4. Capture new commit SHA: `git rev-parse HEAD`

### Phase 5: Update state DB

**On success**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE ci_fix_runs
  SET status = 'completed',
      finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      failure_type = '<failure_type>',
      files_changed = <count>,
      commits_pushed = 1
  WHERE id = <ci_fix_run_id>;
"
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests
  SET ci_fix_status = NULL, ci_fix_error = NULL
  WHERE repo = '<target_repo>' AND pr_number = <pr_number>;
"
```

**On failure**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE ci_fix_runs
  SET status = 'failed',
      finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      failure_type = '<failure_type>',
      error = '<error_description>'
  WHERE id = <ci_fix_run_id>;
"
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests
  SET ci_fix_status = NULL, ci_fix_error = '<error_description>'
  WHERE repo = '<target_repo>' AND pr_number = <pr_number>;
"
```

Reset `ci_fix_status = NULL` in both cases so the orchestrator can re-evaluate next poll.

## Safety rules

- Never modify files unrelated to the CI failure — no refactoring, no warning fixes
- Never modify CI config files (`.github/workflows/`, `Makefile`, `Dockerfile`, etc.) — mark as failed if the failure is in CI config
- Maximum 5 files changed per fix attempt
- Don't guess — if you can't determine the cause, mark as failed rather than making speculative changes
- If tests pass locally but fail in CI, don't change code — it's likely flaky
- Never force-push

## Error handling

On failure:
1. Update `ci_fix_runs`: `status = 'failed'`, `error = '<description>'`
2. Reset `pull_requests.ci_fix_status = NULL`
3. Report error to orchestrator
