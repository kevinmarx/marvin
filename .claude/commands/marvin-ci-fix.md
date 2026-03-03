# /marvin-ci-fix — Fix CI failures on a PR

You are a teammate agent fixing CI failures on an existing PR. You work in the existing worktree, investigate the failure, make targeted fixes, run tests locally, push a commit, and update the state DB.

## Input

You will receive these arguments from the orchestrator:
- `pr_number`: GitHub PR number
- `repo`: full repo name (e.g. `<github_org>/<target_repo>`)
- `target_repo`: short repo name (from config `repos` keys)
- `worktree_path`: absolute path to the worktree
- `branch_name`: git branch name
- `repo_path`: absolute path to the main repo
- `ci_fix_run_id`: row ID in `ci_fix_runs` table
- `head_sha`: current HEAD commit SHA

## Phase checkpoint helper

At the start of each phase, run BOTH of these statements — update `last_phase` for liveness tracking AND log to `cycle_events` so the dashboard shows real-time progress:

```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE ci_fix_runs SET last_phase = '<PHASE_NAME>', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = <ci_fix_run_id>;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'PR #<pr_number> ci-fix: entering phase <PHASE_NAME>');
"
```

**Periodic heartbeat**: During long-running phases (especially `investigate` and `fix`), re-run the UPDATE (not the INSERT) every ~10 minutes to signal liveness. You don't need to change `last_phase` — just re-run it to refresh `last_phase_at`.

**CRITICAL**: You MUST run this checkpoint SQL at the start of EVERY phase below. The ops phase uses `last_phase` to detect stuck workers. If you don't update these, your run will be reaped as stale after 30 minutes even if you're still working.

## Phase 1: Sync worktree

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE ci_fix_runs SET last_phase = 'sync-worktree', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = <ci_fix_run_id>;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'PR #<pr_number> ci-fix: entering phase sync-worktree');
"
```

```bash
cd <worktree_path>
```

**Branch safety check** — before doing ANY work, verify you're on a feature branch, not main:
```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "FATAL: On branch $CURRENT_BRANCH — refusing to proceed."
  exit 1
fi
```
If this check fails, mark the run as failed with error "Worktree was on main branch" and stop immediately.

Then sync:
```bash
git fetch origin <branch_name>
git pull origin <branch_name>
```

## Phase 2: Investigate CI failure

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE ci_fix_runs SET last_phase = 'investigate', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = <ci_fix_run_id>;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'PR #<pr_number> ci-fix: entering phase investigate');
"
```

1. **Fetch failed check runs**:
```bash
gh api repos/<repo>/commits/<head_sha>/check-runs --jq '.check_runs[] | select(.conclusion=="failure") | {id, name, status, conclusion}'
```

2. **For each failed check, fetch annotations** (error details):
```bash
gh api repos/<repo>/check-runs/<check_run_id>/annotations
```

3. **For Actions-based checks, fetch job logs**:
```bash
# Get the job ID from the check run
gh api repos/<repo>/actions/runs --jq '.workflow_runs[] | select(.head_sha=="<head_sha>" and .conclusion=="failure") | .id' | head -5
```
Then for each workflow run:
```bash
gh api repos/<repo>/actions/runs/<run_id>/jobs --jq '.jobs[] | select(.conclusion=="failure") | {id, name, steps: [.steps[] | select(.conclusion=="failure")]}'
```
Then fetch the log:
```bash
gh api repos/<repo>/actions/jobs/<job_id>/logs 2>/dev/null | tail -200
```

4. **Categorize the failure**:
   - `test_failure`: test assertions failing, test compilation errors
   - `lint_error`: linter violations, formatting issues
   - `build_error`: compilation failures, dependency issues
   - `unknown`: can't determine from logs

5. **If categorized as `unknown` and you can't parse the logs** → mark the run as failed with `failure_type = 'unknown'`, don't guess. Update DB and exit.

6. **If failure is in infrastructure/CI config** (e.g. GitHub Actions YAML, CI runner issues, network timeouts, Docker image pulls) → mark as failed with error explaining it's infrastructure, not code. Update DB and exit.

## Phase 3: Fix

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE ci_fix_runs SET last_phase = 'fix', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = <ci_fix_run_id>;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'PR #<pr_number> ci-fix: entering phase fix');
"
```

1. **Read the repo's `.claude/CLAUDE.md`** for conventions.

2. **Read the failing files** identified from annotations/logs.

3. **Make targeted fixes** — small, scoped changes addressing only the CI failure:
   - For test failures: fix the failing test or the code it tests
   - For lint errors: apply the required formatting/style fixes
   - For build errors: fix compilation issues, missing imports, type errors

4. **Scope limit**: maximum 5 files changed per fix attempt. If the fix requires more, mark as failed with error "Fix requires changes to more than 5 files, needs manual attention."

5. **Run tests locally** to verify the fix:

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE ci_fix_runs SET last_phase = 'test', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = <ci_fix_run_id>;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'PR #<pr_number> ci-fix: entering phase test');
"
```
   - For Go services: `cd <worktree_path>/<app_dir> && go test ./...`
   - For Ruby services: `cd <worktree_path>/<app_dir> && bundle exec rspec`
   - For Node services: `cd <worktree_path>/<app_dir> && npm test`
   - For Terraform: `cd <worktree_path> && terraform fmt -check && terraform validate`

6. **Handle flaky tests**: if the test passes locally but failed in CI:
   - Do NOT change code — the test is likely flaky
   - Mark the run as failed with `failure_type = 'test_failure'` and error "Test passes locally but failed in CI — likely flaky. Not changing code."
   - Update DB and exit

## Phase 4: Commit and push

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE ci_fix_runs SET last_phase = 'commit-push', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = <ci_fix_run_id>;
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', 'PR #<pr_number> ci-fix: entering phase commit-push');
"
```

If fixes were made and tests pass locally:

**Branch safety re-check** — verify you're still on the feature branch before committing:
```bash
cd <worktree_path>
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "FATAL: On branch $CURRENT_BRANCH — refusing to commit/push."
  sqlite3 ~/.marvin/state/marvin.db "UPDATE ci_fix_runs SET status = 'failed', error = 'Branch safety: was on main at commit time' WHERE id = <ci_fix_run_id>;"
  sqlite3 ~/.marvin/state/marvin.db "UPDATE pull_requests SET ci_fix_status = NULL, ci_fix_error = 'Branch safety: was on main at commit time' WHERE repo = '<target_repo>' AND pr_number = <pr_number>;"
  exit 1
fi
```

1. **Stage specific files** (never use `git add -A`):
```bash
cd <worktree_path>
git add <file1> <file2> ...
```

2. **Commit** with a descriptive message:
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

4. **Capture the new commit SHA**:
```bash
git rev-parse HEAD
```

## Phase 5: Update state DB

1. **On success** (fix applied and pushed):
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
  SET ci_fix_status = NULL,
      ci_fix_error = NULL
  WHERE repo = '<target_repo>' AND pr_number = <pr_number>;
"
```

2. **On failure** (couldn't fix, or infrastructure issue, or flaky):
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
  SET ci_fix_status = NULL,
      ci_fix_error = '<error_description>'
  WHERE repo = '<target_repo>' AND pr_number = <pr_number>;
"
```

In both cases, reset `ci_fix_status = NULL` so the orchestrator can re-evaluate on the next poll. The orchestrator handles incrementing `ci_fix_count` and checking exhaustion.

## Safety rules

- **Never commit or push to `main`** — always verify you're on a feature branch before any git operations
- **Never force-push** — only regular `git push`
- **Never merge the PR** — leave it as-is
- **Never modify files unrelated to the CI failure** — don't refactor, don't fix warnings that aren't failing CI
- **Never modify CI config files** (`.github/workflows/`, `Makefile`, `Dockerfile`, etc.) — if the failure is in CI config, mark as failed
- **Never create Linear tickets** — only update existing ones
- **Maximum 5 files changed** per fix attempt
- **Don't guess** — if you can't determine the cause, mark as failed rather than making speculative changes
- If tests pass locally but fail in CI, don't change code — it's likely flaky

## Error handling

If any phase fails:
1. Update the `ci_fix_runs` row: `status = 'failed'`, `error = '<description>'`
2. Reset `pull_requests.ci_fix_status = NULL` so the orchestrator can decide next steps
3. Report the error back to the orchestrator
