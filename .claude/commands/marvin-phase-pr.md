# /marvin-phase-pr — PR management phase

You are a Marvin phase agent. Your job: poll open PRs, detect CI failures, detect audit candidates, poll review comments, undraft ready PRs, and queue worker spawn requests. Queue all worker spawn requests in the `spawn_queue` DB table — the orchestrator will spawn them after this phase exits. Then exit with a summary.

**Read config** from the path provided in the prompt (the `Config:` parameter). If no config path is provided, fall back to `config/default.json` (relative to the marvin repo root). Extract these config values: `team`, `assignee`, `repos`, `worktree_root`, `github_org`, `github_user`, `branch_prefix`, `marvin_repo_path`. Identify the **primary audit repo** — the first repo listed in `config.repos` (this is the repo that gets full audit coverage).

## Constants

```
DB_PATH="$HOME/.marvin/state/marvin.db"
```

Track these counters: `polled=0`, `rebase=0`, `ci_fix=0`, `audit=0`, `review=0`, `undrafted=0`, `docs=0`, `concurrency_deferred=0`.

## 1. Poll open PRs

Fetch all open PRs by `github_user` (from config) across all repos in `config.repos` and upsert into `pull_requests`.

For each repo in `config.repos`:

a. **Fetch open PRs**:
```bash
gh pr list --repo <github_org>/<repo> --author <github_user> --state open \
  --json number,title,url,headRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup,createdAt,updatedAt,mergeable,mergeStateStatus
```

b. **For each PR**, determine fields:

- **CI status** from `statusCheckRollup`: if all checks `SUCCESS` or `NEUTRAL` → `success`; any `FAILURE` → `failure`; any `PENDING` → `pending`; no checks → `neutral`
- **Unresolved threads** via GraphQL:
  ```bash
  gh api graphql -f query='query { repository(owner:"<github_org>",name:"<repo>") {
    pullRequest(number:<N>) { reviewThreads(first:100) { nodes { isResolved } } }
  }}' --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)] | length'
  ```
- **Staging check**:
  ```bash
  gh api repos/<github_org>/<repo>/compare/staging...<headRefName> --jq '.status'
  ```
  `on_staging = 1` if status is `identical` or `behind`. If the API call fails (e.g. no staging branch), default to `0`.
- **Behind main**: compute how many commits the PR is behind `main`:
  ```bash
  BEHIND_BY=$(gh api repos/<github_org>/<repo>/compare/<headRefName>...main --jq '.ahead_by' 2>/dev/null || echo "0")
  ```
  Also capture `mergeable` and `mergeStateStatus` from the `gh pr list` JSON output (already fetched in step 1a).
- **ready_to_merge**: `1` if `ci_status = 'success' AND review_decision = 'APPROVED' AND unresolved_threads = 0 AND is_draft = 0 AND mergeable = 'MERGEABLE'`, else `0`
- **ticket_linear_id**: if `headRefName` matches `<branch_prefix from config>/gm-(\d+)-`, extract the number, look up `identifier LIKE 'GM-<number>'` in `tickets` table, and use its `linear_id`. Otherwise `NULL`.

c. **Upsert each PR**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO pull_requests (pr_number, repo, title, url, head_branch, state, is_draft, ci_status, review_decision, unresolved_threads, on_staging, ready_to_merge, ticket_linear_id, gh_created_at, gh_updated_at, head_sha, author, mergeable, merge_state, behind_by, last_polled_at)
  VALUES (<pr_number>, '<repo>', '<title>', '<url>', '<head_branch>', 'open', <is_draft>, '<ci_status>', '<review_decision>', <unresolved_threads>, <on_staging>, <ready_to_merge>, '<ticket_linear_id_or_NULL>', '<created_at>', '<updated_at>', '<head_ref_oid>', '<github_user>', '<mergeable>', '<merge_state>', <behind_by>, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(repo, pr_number) DO UPDATE SET
    title = excluded.title,
    url = excluded.url,
    head_branch = excluded.head_branch,
    state = excluded.state,
    is_draft = excluded.is_draft,
    ci_status = excluded.ci_status,
    review_decision = excluded.review_decision,
    unresolved_threads = excluded.unresolved_threads,
    on_staging = excluded.on_staging,
    ready_to_merge = excluded.ready_to_merge,
    ticket_linear_id = excluded.ticket_linear_id,
    gh_created_at = excluded.gh_created_at,
    gh_updated_at = excluded.gh_updated_at,
    head_sha = excluded.head_sha,
    author = excluded.author,
    mergeable = excluded.mergeable,
    merge_state = excluded.merge_state,
    behind_by = excluded.behind_by,
    rebase_status = CASE
      WHEN excluded.mergeable = 'MERGEABLE' AND pull_requests.rebase_status IN ('conflict','exhausted')
      THEN NULL ELSE pull_requests.rebase_status END,
    rebase_count = CASE
      WHEN excluded.mergeable = 'MERGEABLE' AND pull_requests.rebase_status IN ('conflict','exhausted')
      THEN 0 ELSE pull_requests.rebase_count END,
    rebase_error = CASE
      WHEN excluded.mergeable = 'MERGEABLE' AND pull_requests.rebase_status IN ('conflict','exhausted')
      THEN NULL ELSE pull_requests.rebase_error END,
    last_polled_at = excluded.last_polled_at;
"
```

Increment `polled` counter for each PR upserted.

d. **Mark disappeared PRs**: any row for this repo still `state = 'open'` but `pr_number` not in the fetched set — these were merged or closed on GitHub. Check each one to determine the correct final state:

```bash
# Find disappeared PRs
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, ticket_linear_id
  FROM pull_requests WHERE repo = '<repo>' AND state = 'open'
    AND pr_number NOT IN (<comma_separated_fetched_pr_numbers>);
"
```

For each disappeared PR:
```bash
FINAL_STATE=$(gh pr view <pr_number> --repo <github_org>/<repo> --json state -q '.state' 2>/dev/null)
```

Update `pull_requests`:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests SET state = '<merged or closed>', last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE repo = '<repo>' AND pr_number = <pr_number>;
"
```
(Use `'merged'` if `FINAL_STATE` is `MERGED`, `'closed'` otherwise.)

If `FINAL_STATE` is `MERGED` and the PR has a `ticket_linear_id`, also update the ticket:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET status = 'merged', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<ticket_linear_id>' AND status = 'done';
"
```
And move the ticket to Done in Linear:
```
update_issue(id: "<ticket_linear_id>", state: "done")
```

e. **Fetch ALL open PRs on the primary audit repo for audit** (no `--author` filter):

This is a secondary fetch specifically for the audit system. It ensures the `pull_requests` table tracks all PRs on the primary audit repo, not just the configured user's.

```bash
gh pr list --repo <github_org>/<primary_audit_repo> --state open \
  --json number,title,url,headRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup,createdAt,updatedAt,author,mergeable,mergeStateStatus --limit 100
```

For each PR returned:
- Extract the `author.login` field as the PR author
- Compute CI status, unresolved threads, staging, ready_to_merge, ticket_linear_id same as above
- **Upsert** using the same SQL as step 1c, but with the actual PR author instead of `<github_user>`:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO pull_requests (pr_number, repo, title, url, head_branch, state, is_draft, ci_status, review_decision, unresolved_threads, on_staging, ready_to_merge, ticket_linear_id, gh_created_at, gh_updated_at, head_sha, author, mergeable, merge_state, behind_by, last_polled_at)
  VALUES (<pr_number>, '<primary_audit_repo>', '<title>', '<url>', '<head_branch>', 'open', <is_draft>, '<ci_status>', '<review_decision>', <unresolved_threads>, <on_staging>, <ready_to_merge>, '<ticket_linear_id_or_NULL>', '<created_at>', '<updated_at>', '<head_ref_oid>', '<author_login>', '<mergeable>', '<merge_state>', <behind_by>, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  ON CONFLICT(repo, pr_number) DO UPDATE SET
    title = excluded.title,
    url = excluded.url,
    head_branch = excluded.head_branch,
    state = excluded.state,
    is_draft = excluded.is_draft,
    ci_status = excluded.ci_status,
    review_decision = excluded.review_decision,
    unresolved_threads = excluded.unresolved_threads,
    on_staging = excluded.on_staging,
    ready_to_merge = excluded.ready_to_merge,
    ticket_linear_id = COALESCE(excluded.ticket_linear_id, pull_requests.ticket_linear_id),
    gh_created_at = excluded.gh_created_at,
    gh_updated_at = excluded.gh_updated_at,
    head_sha = excluded.head_sha,
    author = excluded.author,
    mergeable = excluded.mergeable,
    merge_state = excluded.merge_state,
    behind_by = excluded.behind_by,
    rebase_status = CASE
      WHEN excluded.mergeable = 'MERGEABLE' AND pull_requests.rebase_status IN ('conflict','exhausted')
      THEN NULL ELSE pull_requests.rebase_status END,
    rebase_count = CASE
      WHEN excluded.mergeable = 'MERGEABLE' AND pull_requests.rebase_status IN ('conflict','exhausted')
      THEN 0 ELSE pull_requests.rebase_count END,
    rebase_error = CASE
      WHEN excluded.mergeable = 'MERGEABLE' AND pull_requests.rebase_status IN ('conflict','exhausted')
      THEN NULL ELSE pull_requests.rebase_error END,
    last_polled_at = excluded.last_polled_at;
"
```

**Note**: The CI-fix (step 2) and review (step 5/6) steps continue filtering by `ticket_linear_id` so they only act on Marvin's own PRs. The all-PRs fetch is solely for audit coverage.

## 1c. Auto-rebase behind PRs

Auto-rebase the configured assignee's PRs that are behind main when they're otherwise ready to ship. Read `rebase_max_attempts` and `rebase_min_interval_minutes` from `config.limits`.

**Find rebase candidates** — the assignee's PRs that are behind main or conflicting, with CI passing and reviews addressed:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, head_branch, url, ticket_linear_id, behind_by, mergeable
  FROM pull_requests
  WHERE state = 'open'
    AND author = '<github_user>'
    AND (behind_by > 0 OR mergeable = 'CONFLICTING')
    AND (rebase_status IS NULL OR rebase_status NOT IN ('in_progress', 'exhausted'))
    AND rebase_count < <rebase_max_attempts>
    AND (rebase_last_attempt_at IS NULL
         OR rebase_last_attempt_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-<rebase_min_interval_minutes> minutes'))
    AND ci_status = 'success'
    AND (ci_fix_status IS NULL OR ci_fix_status NOT IN ('pending_fix', 'fix_in_progress'))
    AND (review_decision = 'APPROVED' OR unresolved_threads = 0);
"
```

For each candidate:

a. **Set rebase in progress**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests
  SET rebase_status = 'in_progress',
      rebase_count = rebase_count + 1,
      rebase_last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE repo = '<repo>' AND pr_number = <pr_number>;
"
```

b. **Find worktree**: if `ticket_linear_id` is not NULL, look up `worktree_path` from tickets table. Otherwise create a temp worktree:
```bash
WORKTREE="<worktree_root>/<repo>-pr-<pr_number>"
if [ ! -d "$WORKTREE" ]; then
  cd <repo_path>
  git fetch origin <head_branch>
  git worktree add "$WORKTREE" "origin/<head_branch>"
fi
```

c. **Branch safety check** — abort if on main/master:
```bash
cd <worktree_path>
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  # ABORT — never rebase on main
  sqlite3 ~/.marvin/state/marvin.db "
    UPDATE pull_requests SET rebase_status = 'conflict', rebase_error = 'Branch safety: on main/master'
    WHERE repo = '<repo>' AND pr_number = <pr_number>;
  "
  continue
fi
```

d. **Rebase onto main**:
```bash
cd <worktree_path>
git fetch origin main
git rebase origin/main
```

- **Success**: push with lease and record success:
```bash
git push --force-with-lease origin HEAD:refs/heads/<head_branch>
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests SET rebase_status = 'success', rebase_error = NULL
  WHERE repo = '<repo>' AND pr_number = <pr_number>;
"
```
Log a cycle event: `rebase_success` — `"Rebased PR #<pr_number> (<repo>) onto main"`

- **Failure**: abort and record conflict:
```bash
git rebase --abort
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests SET rebase_status = 'conflict', rebase_error = 'Merge conflicts during rebase'
  WHERE repo = '<repo>' AND pr_number = <pr_number>;
"
gh pr comment <pr_number> --repo <github_org>/<repo> --body "$(cat <<'EOF'
🤖 **Marvin — Rebase conflict**

I tried to rebase this PR onto main but hit merge conflicts I can't resolve automatically. Manual rebase needed.
EOF
)"
```
Log a cycle event: `rebase_conflict` — `"Rebase conflict on PR #<pr_number> (<repo>)"`

Increment `rebase` counter for each attempt.

**Exhaustion check**: mark PRs that have hit the max attempts:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests
  SET rebase_status = 'exhausted'
  WHERE state = 'open'
    AND rebase_count >= <rebase_max_attempts>
    AND (rebase_status IS NULL OR rebase_status NOT IN ('exhausted', 'success'));
"
```

## 2. Detect CI failures

**Recovery first**: clear stale statuses when CI passes:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests
  SET ci_fix_status = NULL, ci_fix_count = 0, ci_fix_error = NULL
  WHERE state = 'open'
    AND ci_fix_status IN ('exhausted', 'infrastructure_skip')
    AND ci_status = 'success';
"
```

**Mark infrastructure failures**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests
  SET ci_fix_status = 'infrastructure_skip'
  WHERE state = 'open'
    AND ci_status = 'failure'
    AND ci_fix_error IS NOT NULL
    AND (ci_fix_error LIKE '%infrastructure%' OR ci_fix_error LIKE '%CI config%' OR ci_fix_error LIKE '%stale%node%' OR ci_fix_error LIKE '%GitHub Action%failed%')
    AND (ci_fix_status IS NULL OR ci_fix_status NOT IN ('pending_fix', 'fix_in_progress', 'exhausted', 'infrastructure_skip'));
"
```

**Find PRs needing CI fix**:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, title, url, head_branch, ci_fix_count, ci_fix_status, ci_fix_error, ticket_linear_id
  FROM pull_requests
  WHERE state = 'open'
    AND ci_status = 'failure'
    AND (ci_fix_status IS NULL OR ci_fix_status NOT IN ('pending_fix', 'fix_in_progress', 'exhausted', 'infrastructure_skip'))
    AND ci_fix_count < 5
    AND (ci_fix_last_attempt_at IS NULL OR ci_fix_last_attempt_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-10 minutes'));
"
```

For each PR returned:

a. **Check no active `ci_fix_runs` row** (skip if one is already running):
```bash
RUNNING=$(sqlite3 ~/.marvin/state/marvin.db "
  SELECT COUNT(*) FROM ci_fix_runs
  WHERE repo = '<repo>' AND pr_number = <pr_number> AND status = 'running';
")
```
If `RUNNING > 0`, skip this PR.

b. **Set `ci_fix_status = 'pending_fix'`**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests SET ci_fix_status = 'pending_fix'
  WHERE repo = '<repo>' AND pr_number = <pr_number>;
"
```

## 2b. Concurrency check

Before spawning any workers in subsequent steps, check available slots. This query is the **single source of truth** for how many workers are currently running:

```bash
RUNNING=$(sqlite3 ~/.marvin/state/marvin.db "
  SELECT
    (SELECT COUNT(*) FROM tickets WHERE status IN ('executing', 'exploring')) +
    (SELECT COUNT(*) FROM audit_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM review_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM ci_fix_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM doc_runs WHERE status = 'running');
")
SLOTS=$((8 - RUNNING))
if [ "$SLOTS" -lt 0 ]; then SLOTS=0; fi
```

Track `SLOTS` as a decrementing counter through steps 3, 4.5, 5b, 6, and 8. Before creating any `_runs` row or spawn_queue entry, check `SLOTS > 0`. If no slots:
- **CI-fix (step 3)**: Leave `ci_fix_status = 'pending_fix'` — will retry next cycle
- **Audit (step 4.5)**: Leave `audit_status = 'pending_audit'` — will retry next cycle
- **Review (step 5b/6)**: Leave `review_status = 'pending_review'` or docs review pending — will retry next cycle
- **Docs (step 8)**: Skip doc_run creation — knowledge file persists for next cycle

After each worker is queued, decrement `SLOTS`. Increment `concurrency_deferred` for each skipped worker.

Re-run the slots query before step 4.5 (audit), before step 5b/6 (reviews), and before step 8 (docs) since earlier steps may have consumed slots.

## 3. Spawn CI-fix teammates

For each PR where `ci_fix_status = 'pending_fix'`:

```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, title, url, head_branch, ci_fix_count, ticket_linear_id
  FROM pull_requests
  WHERE state = 'open' AND ci_fix_status = 'pending_fix';
"
```

For each PR:

**Check slots first**: If `SLOTS <= 0`, leave `ci_fix_status = 'pending_fix'` and skip this PR (increment `concurrency_deferred`). It will be picked up next cycle.

a. **Ensure worktree exists**:
   - If PR has `ticket_linear_id` → look up the ticket's `worktree_path` from the `tickets` table
   - Otherwise → create at `<worktree_root>/<repo>-pr-<pr_number>` from `origin/<head_branch>`:
```bash
WORKTREE="<worktree_root>/<repo>-pr-<pr_number>"
if [ ! -d "$WORKTREE" ]; then
  cd <repo_path>
  git fetch origin <head_branch>
  git worktree add "$WORKTREE" "origin/<head_branch>"
fi
```

b. **Get HEAD SHA**:
```bash
cd <worktree_path>
HEAD_SHA=$(git rev-parse HEAD)
```

c. **Insert a `ci_fix_runs` row**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO ci_fix_runs (pr_number, repo)
  VALUES (<pr_number>, '<repo>');
"
CI_FIX_RUN_ID=$(sqlite3 ~/.marvin/state/marvin.db "SELECT last_insert_rowid();")
```

d. **Update PR state**: set `ci_fix_status = 'fix_in_progress'`, increment `ci_fix_count`, record timestamp:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests
  SET ci_fix_status = 'fix_in_progress',
      ci_fix_count = ci_fix_count + 1,
      ci_fix_last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE repo = '<repo>' AND pr_number = <pr_number>;
"
```

e. **Queue the CI-fix teammate** by inserting into the spawn queue. The orchestrator will spawn it after this phase exits:

Build the full prompt (include all context: `pr_number`, `repo` (full, e.g. `<github_org>/<target_repo>`), `target_repo` (short, e.g. `<repo_name>`), `worktree_path`, `branch_name` (`head_branch`), `repo_path`, `ci_fix_run_id`, `head_sha`. Reference `/marvin-ci-fix` instructions), then insert:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO spawn_queue (worker_type, worker_name, prompt)
  VALUES ('ci_fix', 'ci-fix-<repo>-<pr_number>', '<prompt — escape single quotes by doubling them>');
"
```

Increment `ci_fix` counter.
Decrement `SLOTS`.

**Exhaustion check**: check if any PRs have reached the exhaustion threshold:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, ci_fix_error, url
  FROM pull_requests
  WHERE state = 'open'
    AND ci_status = 'failure'
    AND ci_fix_count >= 5
    AND (ci_fix_status IS NULL OR ci_fix_status != 'exhausted');
"
```

For each exhausted PR:
1. Set `ci_fix_status = 'exhausted'`
2. Post a PR comment:
```bash
gh pr comment <pr_number> --repo <github_org>/<repo> --body "$(cat <<'EOF'
🤖 **Marvin — CI fix attempts exhausted**

I've tried to fix the CI failure 5 times but haven't been able to resolve it. This PR needs manual attention.

Last error: <ci_fix_error>
EOF
)"
```

## 4. Detect PRs needing audit (primary audit repo only)

**Reset stale audits first**: if any PR has `audit_status = 'audit_in_progress'` but no running `audit_runs` row, reset to `NULL`:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests
  SET audit_status = NULL
  WHERE repo = '<primary_audit_repo>'
    AND audit_status = 'audit_in_progress'
    AND NOT EXISTS (
      SELECT 1 FROM audit_runs
      WHERE audit_runs.repo = pull_requests.repo
        AND audit_runs.pr_number = pull_requests.pr_number
        AND audit_runs.status = 'running'
    );
"
```

**Find PRs needing audit**: open, non-draft PRs on the primary audit repo that haven't been audited at this SHA:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, title, url, head_branch, head_sha, author
  FROM pull_requests
  WHERE repo = '<primary_audit_repo>'
    AND state = 'open'
    AND is_draft = 0
    AND (
      audit_status IS NULL
      OR (audit_status = 'audited' AND head_sha != audit_last_sha)
    )
    AND (audit_status IS NULL OR audit_status NOT IN ('pending_audit', 'audit_in_progress'))
    AND head_sha IS NOT NULL;
"
```

For each PR returned, set `audit_status = 'pending_audit'`:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests SET audit_status = 'pending_audit'
  WHERE repo = '<primary_audit_repo>' AND pr_number = <pr_number>;
"
```

## 4.5. Spawn audit teammates

**Re-check available slots** before spawning auditors (CI-fix may have consumed some):
```bash
RUNNING=$(sqlite3 ~/.marvin/state/marvin.db "
  SELECT
    (SELECT COUNT(*) FROM tickets WHERE status IN ('executing', 'exploring')) +
    (SELECT COUNT(*) FROM audit_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM review_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM ci_fix_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM doc_runs WHERE status = 'running');
")
SLOTS=$((8 - RUNNING))
if [ "$SLOTS" -lt 0 ]; then SLOTS=0; fi
```

For each PR where `audit_status = 'pending_audit'`:

```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, title, url, head_branch, head_sha, author
  FROM pull_requests
  WHERE repo = '<primary_audit_repo>' AND audit_status = 'pending_audit';
"
```

For each PR:

**Check slots first**: If `SLOTS <= 0`, leave `audit_status = 'pending_audit'` on remaining PRs and skip them (increment `concurrency_deferred` for each). They will be picked up next cycle.

a. **Insert an `audit_runs` row**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO audit_runs (pr_number, repo, head_sha)
  VALUES (<pr_number>, '<primary_audit_repo>', '<head_sha>');
"
AUDIT_RUN_ID=$(sqlite3 ~/.marvin/state/marvin.db "SELECT last_insert_rowid();")
```

b. **Set `audit_status = 'audit_in_progress'`**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests SET audit_status = 'audit_in_progress'
  WHERE repo = '<primary_audit_repo>' AND pr_number = <pr_number>;
"
```

c. **Check if this is a re-review** — look for a previous audit run on this PR:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT id, risk_level, size_label, findings_count, head_sha
  FROM audit_runs
  WHERE repo = '<primary_audit_repo>' AND pr_number = <pr_number> AND status = 'completed'
  ORDER BY finished_at DESC LIMIT 1;
"
```
Also check the current review state:
```bash
REVIEW_STATE=$(gh api repos/<github_org>/<primary_audit_repo>/pulls/<pr_number>/reviews --jq '[.[] | select(.user.login=="<github_user from config>")] | last | .state' 2>/dev/null)
```
If a previous audit run exists, this is a re-review. Pass `previous_audit_risk`, `previous_audit_sha`, `previous_review_state` to the teammate.

d. **Queue the audit teammate** by inserting into the spawn queue. The orchestrator will spawn it after this phase exits:

Build the full prompt (include all context: `pr_number`, `repo` (`<github_org>/<primary_audit_repo>`), `target_repo` (`<primary_audit_repo>`), `repo_path` (`<path from config.repos for the primary audit repo>`), `head_sha`, `audit_run_id`, `db_path` (`~/.marvin/state/marvin.db`). If this is a re-review, also include `previous_audit_risk`, `previous_audit_sha`, `previous_review_state`. Reference `/marvin-audit` instructions), then insert:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO spawn_queue (worker_type, worker_name, prompt)
  VALUES ('auditor', 'audit-<primary_audit_repo>-<pr_number>', '<prompt — escape single quotes by doubling them>');
"
```

No worktree needed — audit is read-only, uses `gh pr diff` and the main repo checkout for context.

Increment `audit` counter.
Decrement `SLOTS`.

## 5. Poll for PR review comments

Check GitHub for review comments on all open Marvin PRs. Read `github_org` and `github_user` from config.

For each ticket in the state DB where `status = 'done'` AND `pr_number IS NOT NULL` AND (`review_status IS NULL` OR `review_status != 'review_in_progress'`):

```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT linear_id, identifier, pr_number, target_repo, branch_name, worktree_path
  FROM tickets
  WHERE status = 'done'
    AND pr_number IS NOT NULL
    AND (review_status IS NULL OR review_status != 'review_in_progress');
"
```

For each ticket returned:

a. **Check if PR is still open**:
```bash
gh pr view <pr_number> --repo <github_org>/<target_repo> --json state -q '.state'
```
If `MERGED` or `CLOSED`:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET status = 'merged', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<linear_id>';
"
```
(Use `'closed'` instead of `'merged'` if the PR state is `CLOSED`.)

Also update the ticket in Linear to "Done" state:
```
update_issue(id: "<linear_id>", state: "done")
```

Skip to the next ticket — no need to check review comments on merged/closed PRs.

b. **Fetch inline review comments** (code-level comments):
```bash
gh api repos/<github_org>/<target_repo>/pulls/<pr_number>/comments --paginate
```

c. **Fetch review bodies** (top-level review comments with body text):
```bash
gh api repos/<github_org>/<target_repo>/pulls/<pr_number>/reviews --paginate
```

d. **Filter out**:
   - Comments by `github_user` from config (the configured GitHub username)
   - Comments by bots (author login containing `[bot]` or `marvin`)
   - Empty review bodies (approvals with no text)
   - Comments already in the `review_comments` DB table (check by `comment_id`)

e. **Insert new comments** into `review_comments` table:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT OR IGNORE INTO review_comments
    (ticket_linear_id, pr_number, repo, comment_id, thread_node_id, author, body, path, line, status, created_at)
  VALUES
    ('<linear_id>', <pr_number>, '<github_org>/<target_repo>', <comment_id>, '<node_id>', '<author>', '<body>', '<path>', <line>, 'pending', '<created_at>');
"
```

f. **Check for pending comments** on this ticket:
```bash
PENDING=$(sqlite3 ~/.marvin/state/marvin.db "
  SELECT COUNT(*) FROM review_comments
  WHERE ticket_linear_id = '<linear_id>' AND status = 'pending';
")
```
If `PENDING > 0`, set `review_status = 'pending_review'`:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET review_status = 'pending_review',
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<linear_id>';
"
```

## 5b. Poll review comments on documentation PRs

**Re-check available slots** before spawning reviewers:
```bash
RUNNING=$(sqlite3 ~/.marvin/state/marvin.db "
  SELECT
    (SELECT COUNT(*) FROM tickets WHERE status IN ('executing', 'exploring')) +
    (SELECT COUNT(*) FROM audit_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM review_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM ci_fix_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM doc_runs WHERE status = 'running');
")
SLOTS=$((8 - RUNNING))
if [ "$SLOTS" -lt 0 ]; then SLOTS=0; fi
```

Docs PRs (from `/marvin-docs`) are tracked in `doc_runs`, not `tickets`. Poll them separately.

```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT d.id AS doc_run_id, d.ticket_identifier, d.pr_number, d.repo AS target_repo,
         p.head_branch AS branch_name, p.unresolved_threads
  FROM doc_runs d
  JOIN pull_requests p ON p.pr_number = d.pr_number AND p.repo = d.repo
  WHERE d.status = 'completed'
    AND d.pr_number IS NOT NULL
    AND p.state = 'open';
"
```

For each docs PR returned:

a. **Fetch inline review comments**:
```bash
gh api repos/<github_org>/<target_repo>/pulls/<pr_number>/comments --paginate
```

b. **Fetch review bodies**:
```bash
gh api repos/<github_org>/<target_repo>/pulls/<pr_number>/reviews --paginate
```

c. **Filter out** (same rules as step 5d):
   - Comments by `github_user` from config (the configured GitHub username)
   - Comments by bots (author login containing `[bot]` or `marvin`)
   - Empty review bodies (approvals with no text)
   - Comments already in the `review_comments` DB table (check by `comment_id`)

d. **Insert new comments** into `review_comments` table. Use `'docs-<ticket_identifier>'` as the `ticket_linear_id` to distinguish docs review comments from ticket review comments:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT OR IGNORE INTO review_comments
    (ticket_linear_id, pr_number, repo, comment_id, thread_node_id, author, body, path, line, status, created_at)
  VALUES
    ('docs-<ticket_identifier>', <pr_number>, '<github_org>/<target_repo>', <comment_id>, '<node_id>', '<author>', '<body>', '<path>', <line>, 'pending', '<created_at>');
"
```

e. **Check for pending comments** and spawn reviewer if needed:
```bash
PENDING=$(sqlite3 ~/.marvin/state/marvin.db "
  SELECT COUNT(*) FROM review_comments
  WHERE ticket_linear_id = 'docs-<ticket_identifier>' AND status = 'pending';
")
```

If `PENDING > 0`:

0. **Check slots**: If `SLOTS <= 0`, skip spawning reviewer for this docs PR (increment `concurrency_deferred`). The pending comments will be picked up next cycle.

1. **Check no active review run exists**:
```bash
RUNNING=$(sqlite3 ~/.marvin/state/marvin.db "
  SELECT COUNT(*) FROM review_runs
  WHERE ticket_linear_id = 'docs-<ticket_identifier>' AND status = 'running';
")
```
If `RUNNING > 0`, skip.

2. **Ensure worktree exists**:
```bash
WORKTREE="<worktree_root>/<target_repo>-docs-<ticket_identifier>"
if [ ! -d "$WORKTREE" ]; then
  cd <repo_path>
  git fetch origin <branch_name>
  git worktree add "$WORKTREE" "origin/<branch_name>"
fi
```

3. **Write pending comments to temp file**:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT comment_id, author, body, path, line, thread_node_id
  FROM review_comments
  WHERE ticket_linear_id = 'docs-<ticket_identifier>' AND status = 'pending';
" > /tmp/marvin-review-docs-<ticket_identifier>.json
```

4. **Insert review_runs row**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO review_runs (ticket_linear_id, pr_number)
  VALUES ('docs-<ticket_identifier>', <pr_number>);
"
```

5. **Queue reviewer** by inserting into the spawn queue. The orchestrator will spawn it after this phase exits:

Build the full prompt (include: `ticket_linear_id` (`docs-<ticket_identifier>`), `identifier` (`docs-<ticket_identifier>`), `pr_number`, `repo` (`<github_org>/<target_repo>`), `target_repo`, `worktree_path`, `branch_name`, `comments_json_path`, `repo_path`. Reference `/marvin-review` instructions), then insert:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO spawn_queue (worker_type, worker_name, prompt)
  VALUES ('reviewer', 'review-docs-<ticket_identifier>', '<prompt — escape single quotes by doubling them>');
"
```

Increment `review` counter.
Decrement `SLOTS`.

## 6. Spawn review teammates

**Re-check available slots** before spawning reviewers:
```bash
RUNNING=$(sqlite3 ~/.marvin/state/marvin.db "
  SELECT
    (SELECT COUNT(*) FROM tickets WHERE status IN ('executing', 'exploring')) +
    (SELECT COUNT(*) FROM audit_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM review_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM ci_fix_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM doc_runs WHERE status = 'running');
")
SLOTS=$((8 - RUNNING))
if [ "$SLOTS" -lt 0 ]; then SLOTS=0; fi
```

For each ticket where `review_status = 'pending_review'`:

```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT linear_id, identifier, pr_number, target_repo, branch_name, worktree_path
  FROM tickets
  WHERE review_status = 'pending_review';
"
```

For each ticket:

**Check slots first**: If `SLOTS <= 0`, leave `review_status = 'pending_review'` on remaining tickets and skip them (increment `concurrency_deferred` for each). They will be picked up next cycle.

a. **Check no active review run exists** (skip if one is already running):
```bash
RUNNING=$(sqlite3 ~/.marvin/state/marvin.db "
  SELECT COUNT(*) FROM review_runs
  WHERE ticket_linear_id = '<linear_id>' AND status = 'running';
")
```
If `RUNNING > 0`, skip this ticket.

b. **Ensure worktree exists** — re-create if it was cleaned up:
```bash
if [ ! -d "<worktree_path>" ]; then
  cd <repo_path>
  git fetch origin main
  git worktree add "<worktree_path>" -b "<branch_name>" "origin/<branch_name>" 2>/dev/null || \
    git worktree add "<worktree_path>" "<branch_name>"
fi
```

c. **Write pending comments to a temp JSON file**:
```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT comment_id, author, body, path, line, thread_node_id
  FROM review_comments
  WHERE ticket_linear_id = '<linear_id>' AND status = 'pending';
" > /tmp/marvin-review-<identifier>.json
```

d. **Insert a review_runs row**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO review_runs (ticket_linear_id, pr_number)
  VALUES ('<linear_id>', <pr_number>);
"
```

e. **Set ticket review_status to review_in_progress**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET review_status = 'review_in_progress',
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<linear_id>';
"
```

f. **Queue the review teammate** by inserting into the spawn queue. The orchestrator will spawn it after this phase exits:

Build the full prompt (include all context: `linear_id`, `identifier`, `pr_number`, `repo` (`<github_org>/<target_repo>`), `target_repo`, `worktree_path`, `branch_name`, `comments_json_path` (`/tmp/marvin-review-<identifier>.json`), `repo_path`. Reference `/marvin-review` instructions), then insert:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO spawn_queue (worker_type, worker_name, prompt)
  VALUES ('reviewer', 'review-<number>', '<prompt — escape single quotes by doubling them>');
"
```

Increment `review` counter.
Decrement `SLOTS`.

## 7. Undraft ready PRs

Check for draft PRs that are ready to be marked as ready for review. A PR is ready when CI passes and all review feedback has been addressed.

```bash
sqlite3 -json ~/.marvin/state/marvin.db "
  SELECT pr_number, repo, title, url
  FROM pull_requests
  WHERE state = 'open'
    AND is_draft = 1
    AND ci_status = 'success'
    AND unresolved_threads = 0
    AND mergeable = 'MERGEABLE'
    AND (rebase_status IS NULL OR rebase_status NOT IN ('in_progress', 'conflict'))
    AND (review_status IS NULL OR review_status NOT IN ('pending_review', 'review_in_progress'));
"
```

For each PR returned, also check with the `tickets` table that no review is in progress:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  SELECT COUNT(*) FROM tickets
  WHERE pr_number = <pr_number> AND review_status IN ('pending_review', 'review_in_progress');
"
```
If count > 0, skip — reviews are still being processed.

Otherwise, **mark the PR as ready for review**:
```bash
gh pr ready <pr_number> --repo <github_org>/<repo>
```

Update the DB:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE pull_requests SET is_draft = 0, last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE repo = '<repo>' AND pr_number = <pr_number>;
"
```

Increment `undrafted` counter.

## 8. Spawn documentation teammates

**Re-check available slots** before spawning docs workers:
```bash
RUNNING=$(sqlite3 ~/.marvin/state/marvin.db "
  SELECT
    (SELECT COUNT(*) FROM tickets WHERE status IN ('executing', 'exploring')) +
    (SELECT COUNT(*) FROM audit_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM review_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM ci_fix_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM doc_runs WHERE status = 'running');
")
SLOTS=$((8 - RUNNING))
if [ "$SLOTS" -lt 0 ]; then SLOTS=0; fi
```

Check for completed tickets that have knowledge files but no doc run yet:

```bash
# Find knowledge files from completed executors
for knowledge_file in /tmp/marvin-knowledge-GM-*.json; do
  [ -f "$knowledge_file" ] || continue
  IDENTIFIER=$(python3 -c "import json; print(json.load(open('$knowledge_file'))['identifier'])")

  # Skip if doc run already exists for this ticket
  EXISTING=$(sqlite3 ~/.marvin/state/marvin.db "
    SELECT COUNT(*) FROM doc_runs WHERE ticket_identifier = '$IDENTIFIER';
  " 2>/dev/null || echo "0")
  [ "$EXISTING" -gt 0 ] && continue

  # Read knowledge file for context
  TARGET_REPO=$(python3 -c "import json; print(json.load(open('$knowledge_file'))['target_repo'])")
  REPO_PATH=$(python3 -c "import json; print(json.load(open('$knowledge_file'))['repo_path'])")
  ORIGINAL_BRANCH=$(python3 -c "import json; print(json.load(open('$knowledge_file'))['branch_name'])")

  # Get the original PR number
  ORIGINAL_PR=$(sqlite3 ~/.marvin/state/marvin.db "
    SELECT pr_number FROM tickets WHERE identifier = '$IDENTIFIER';
  ")

  # Check if knowledge has actionable content (non-empty suggested_updates)
  HAS_UPDATES=$(python3 -c "
import json
k = json.load(open('$knowledge_file'))
updates = k.get('suggested_updates', [])
print(len(updates))
  ")
  if [ "$HAS_UPDATES" -eq 0 ]; then
    # No actionable findings — skip and clean up
    rm -f "$knowledge_file"
    sqlite3 ~/.marvin/state/marvin.db "
      INSERT INTO doc_runs (ticket_identifier, repo, knowledge_path, status, finished_at)
      VALUES ('$IDENTIFIER', '$TARGET_REPO', '$knowledge_file', 'skipped', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
    "
    continue
  fi

  # Check slots — skip if at concurrency limit (knowledge file persists for next cycle)
  if [ "$SLOTS" -le 0 ]; then
    concurrency_deferred=$((concurrency_deferred + 1))
    continue
  fi

  # Insert doc run
  sqlite3 ~/.marvin/state/marvin.db "
    INSERT INTO doc_runs (ticket_identifier, repo, knowledge_path)
    VALUES ('$IDENTIFIER', '$TARGET_REPO', '$knowledge_file');
  "

  # Queue docs teammate via spawn_queue — orchestrator will spawn after this phase exits
  # Build the full prompt with: identifier, target_repo, repo_path, knowledge_path,
  # original_pr_number, original_branch + reference /marvin-docs
  # Then insert into spawn_queue:
  sqlite3 ~/.marvin/state/marvin.db "
    INSERT INTO spawn_queue (worker_type, worker_name, prompt)
    VALUES ('docs', 'docs-$IDENTIFIER', '<prompt — escape single quotes by doubling them>');
  "

  SLOTS=$((SLOTS - 1))
done
```

Increment `docs` counter.

## 9. Log events

For significant actions, log to `cycle_events`:
```bash
CYCLE=$(sqlite3 ~/.marvin/state/marvin.db "SELECT cycle_number FROM heartbeat WHERE id = 1;")
sqlite3 ~/.marvin/state/marvin.db "
  INSERT INTO cycle_events (cycle_number, step, message)
  VALUES ($CYCLE, '<step>', '<message>');
"
```

## Output

When done, print a single summary line to stdout and exit:

```
PR: polled=<N> rebase=<N> ci_fix=<N> audit=<N> review=<N> undrafted=<N> docs=<N> concurrency_deferred=<N>
```

This summary is what the orchestrator (EM) sees — keep it short.

## Safety rules

- **Never create tickets in Linear** — only update existing ones
- Never merge PRs — only undraft when conditions are met
- Never deploy anything
- Never modify main directly — always use worktrees branching from `origin/main`
- Always unset upstream tracking on new worktree branches to prevent accidental push to main
- Always push with explicit refspec (`HEAD:refs/heads/<branch>`) — never rely on upstream tracking
