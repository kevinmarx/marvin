<!-- Generated from skills/phase-pr.md by harness/codex.ts — DO NOT EDIT DIRECTLY -->

# Task: Phase: PR

## Instructions

# Phase: PR — Poll, rebase, CI-fix, audit, review, undraft, docs

You are a Marvin phase agent. Poll open PRs, detect CI failures, detect audit candidates, poll review comments, undraft ready PRs, and queue worker spawn requests in the `spawn_queue` DB table. The orchestrator spawns them after this phase exits. Then exit with a summary.

> Context: See helpers/context-phase-pr.md

**Read config** from the path provided in the prompt (the `Config:` parameter). If no config path is provided, fall back to `config/default.json` (relative to the marvin repo root). Extract: `team`, `assignee`, `repos`, `worktree_root`, `github_org`, `github_user`, `branch_prefix`, `marvin_repo_path`. Identify the **primary audit repo** — the first repo listed in `config.repos`.

Use `state_db` from config (default `~/.marvin/state/marvin.db`) as `DB_PATH`.

**Counters**: `polled=0`, `rebase=0`, `ci_fix=0`, `audit=0`, `review=0`, `undrafted=0`, `docs=0`, `concurrency_deferred=0`.

## 0. Early exit check

Before polling GitHub, check if there are any open PRs worth processing:

```
# [STATE: update state]
```

Also check if any tickets are in executing/exploring status (they'll produce PRs soon):
```
# [STATE: update state]
```

If `open_prs = 0` AND `active_tickets = 0`, **skip the entire phase** — there's nothing to do. Return summary: `PR: skipped (no open PRs or active tickets)` and exit immediately.

---

## 1. Poll open PRs

Fetch all open PRs by `github_user` across all repos in `config.repos` and upsert into `pull_requests`.

### 1a. Fetch per-repo PRs

For each repo in `config.repos`:

```bash
gh pr list --repo <github_org>/<repo> --author <github_user> --state open \
  --json number,title,url,headRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup,createdAt,updatedAt,mergeable,mergeStateStatus
```

### 1b. Compute derived fields per PR

| Field | Source |
|-------|--------|
| `ci_status` | `statusCheckRollup`: all `SUCCESS`/`NEUTRAL` → `success`; any `FAILURE` → `failure`; any `PENDING` → `pending`; no checks → `neutral` |
| `unresolved_threads` | GraphQL: `repository.pullRequest.reviewThreads.nodes` → count where `isResolved == false` |
| `on_staging` | `gh api repos/<org>/<repo>/compare/staging...<headRefName> --jq '.status'` → `1` if `identical` or `behind`, default `0` if fails |
| `behind_by` | `gh api repos/<org>/<repo>/compare/<headRefName>...main --jq '.ahead_by'` (default `0`) |
| `ready_to_merge` | `1` if `ci_status='success' AND review_decision='APPROVED' AND unresolved_threads=0 AND is_draft=0 AND mergeable='MERGEABLE'` |
| `ticket_linear_id` | If `headRefName` matches `<branch_prefix>/gm-(\d+)-`, look up `identifier LIKE 'GM-<number>'` in `tickets` table |

### 1c. Upsert each PR

```
# [STATE: update state]
```

Increment `polled` for each PR upserted.

### 1d. Mark disappeared PRs

PRs in DB as `state='open'` but not in the fetched set were merged or closed on GitHub:

```bash
FINAL_STATE=$(gh pr view <pr_number> --repo <github_org>/<repo> --json state -q '.state' 2>/dev/null)
```

Update `pull_requests.state` to `'merged'` or `'closed'`. If merged and has `ticket_linear_id`:
```
# [STATE: update state]
```
Also move ticket to Done in Linear: `save_issue(id: "<linear_id>", state: "done")`.

### 1e. Fetch ALL open PRs on primary audit repo

Secondary fetch for audit system — no `--author` filter, all PRs on the primary audit repo:

```bash
gh pr list --repo <github_org>/<primary_audit_repo> --state open \
  --json number,title,url,headRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup,createdAt,updatedAt,author,mergeable,mergeStateStatus --limit 100
```

Upsert each with the actual PR `author.login`. Use `COALESCE(excluded.ticket_linear_id, pull_requests.ticket_linear_id)` to preserve existing ticket links. CI-fix and review steps still filter by `ticket_linear_id` so they only act on Marvin's own PRs.

---

## 2. Auto-rebase behind PRs

Read `rebase_max_attempts` and `rebase_min_interval_minutes` from `config.limits`.

### Find rebase candidates

The configured user's PRs that are behind main or conflicting, with CI passing and reviews addressed:
```
# [STATE: update state]
```

### For each candidate

1. **Mark in progress**:
```
# [STATE: update state]
```

2. **Find worktree**: if `ticket_linear_id` is not NULL, look up `worktree_path` from tickets. Otherwise create a temp worktree at `<worktree_root>/<repo>-pr-<pr_number>`.

3. **Run branch safety check** — abort if on main/master. See `helpers/branch-safety.md`.

4. **Rebase**:
```bash
cd <worktree_path>
git fetch origin main
git rebase origin/main
```

5. **On success**:
```bash
git push --force-with-lease origin HEAD:refs/heads/<head_branch>
```
```
# [STATE: update state]
```
Log cycle event: `rebase_success`.

6. **On failure**:
```bash
git rebase --abort
```
```
# [STATE: update state]
```
Post PR comment about rebase conflict. Log cycle event: `rebase_conflict`.

Increment `rebase` counter for each attempt.

### Exhaustion check

```
# [STATE: update state]
```

---

## 3. Detect CI failures

### Recovery — clear stale statuses when CI passes

```
# [STATE: update state]
```

### Mark infrastructure failures

```
# [STATE: update state]
```

### Find PRs needing CI fix

```
# [STATE: update state]
```

For each PR:
- Skip if an active `ci_fix_runs` row exists (`status IN ('running', 'queued')`)
- Set `ci_fix_status = 'pending_fix'`

---

## 4. Concurrency check (shared across steps 4-9)

Single source of truth for running workers:
```
# [STATE: update state]
```

`SLOTS = 8 - running_workers` (floor at 0). Track as decrementing counter. Re-check before each major step (audit, reviews, docs) since earlier steps consume slots.

> **Note**: Phase-pr counts both `'running'` (actually spawned by orchestrator) and `'queued'` (inserted this cycle, awaiting spawn) to avoid over-committing slots. The orchestrator's drain procedure only counts `'running'` since `'queued'` rows are what it's about to activate.

When no slots:
- **CI-fix**: leave `ci_fix_status = 'pending_fix'` — retry next cycle
- **Audit**: leave `audit_status = 'pending_audit'` — retry next cycle
- **Review**: leave `review_status = 'pending_review'` — retry next cycle
- **Docs**: skip doc_run creation — knowledge file persists

After each worker queued, decrement `SLOTS`. Increment `concurrency_deferred` for each skip.

---

## 5. Spawn CI-fix teammates

For each PR where `ci_fix_status = 'pending_fix'`:

**Check slots first**. If `SLOTS <= 0`, leave `pending_fix`, increment `concurrency_deferred`, skip.

1. **Ensure worktree exists**: if PR has `ticket_linear_id`, use ticket's `worktree_path`. Otherwise create at `<worktree_root>/<repo>-pr-<pr_number>`.

2. **Get HEAD SHA**: `git rev-parse HEAD` in worktree.

3. **Insert `ci_fix_runs` row** (with `status = 'queued'` — the orchestrator will set `'running'` when it actually spawns the worker):
```
# [STATE: update state]
```
Capture `last_insert_rowid()`.

4. **Update PR state**:
```
# [STATE: update state]
```

5. **Queue CI-fix** in spawn_queue:
```
# [STATE: update state]
```
Prompt includes: `pr_number`, `repo` (full `<github_org>/<repo>`), `target_repo` (short), `worktree_path`, `branch_name`, `repo_path`, `ci_fix_run_id`, `head_sha`. References `/marvin-ci-fix`.

Increment `ci_fix`, decrement `SLOTS`.

### CI-fix exhaustion check

```
# [STATE: update state]
```

For each: set `ci_fix_status = 'exhausted'`, post PR comment about exhaustion.

---

## 6. Detect PRs needing audit (primary audit repo only)

### Reset stale audits

```
# [STATE: update state]
```

### Find audit candidates

Open, non-draft PRs not yet audited at current SHA:
```
# [STATE: update state]
```

Set `audit_status = 'pending_audit'` for each.

---

## 7. Spawn audit teammates

**Re-check available slots.**

For each PR where `audit_status = 'pending_audit'`:

**Check slots first**. If `SLOTS <= 0`, leave `pending_audit`, increment `concurrency_deferred`, skip.

1. **Insert `audit_runs` row** (with `status = 'queued'` — the orchestrator will set `'running'` when it actually spawns the worker):
```
# [STATE: update state]
```

2. **Set `audit_status = 'audit_in_progress'`**.

3. **Check for re-review**: look for previous completed audit run on this PR:
```
# [STATE: update state]
```
Also check current review state via `gh api`. If previous run exists, include `previous_audit_risk`, `previous_audit_sha`, `previous_review_state` in prompt.

4. **Queue auditor** in spawn_queue:
```
# [STATE: update state]
```
Prompt includes: `pr_number`, `repo`, `target_repo`, `repo_path`, `head_sha`, `audit_run_id`, `db_path`. References `/marvin-audit`. No worktree needed — audit uses `gh pr diff` and main repo checkout.

Increment `audit`, decrement `SLOTS`.

---

## 8. Poll PR review comments

### 8a. Ticket PRs

For each ticket where `status = 'done' AND pr_number IS NOT NULL AND (review_status IS NULL OR review_status != 'review_in_progress')`:

1. **Check PR still open**: if merged/closed, update ticket status and Linear state, skip.

2. **Fetch inline comments**: `gh api repos/<org>/<repo>/pulls/<pr>/comments --paginate`

3. **Fetch review bodies**: `gh api repos/<org>/<repo>/pulls/<pr>/reviews --paginate`

4. **Filter out**:
   - Comments by `github_user` (configured username)
   - Bot comments (login contains `[bot]` or `marvin`)
   - Empty review bodies
   - Comments already in `review_comments` table (by `comment_id`)

5. **Insert new comments**:
```
# [STATE: update state]
```

6. **Set `review_status = 'pending_review'`** if pending comments exist.

### 8b. Documentation PRs

Docs PRs are tracked in `doc_runs`, not `tickets`:
```
# [STATE: update state]
```

Same comment polling as ticket PRs. Use `'docs-<ticket_identifier>'` as `ticket_linear_id` to distinguish.

If pending comments exist and slots available, spawn reviewer:
1. Check no active review run exists (`status IN ('running', 'queued')`)
2. Ensure worktree at `<worktree_root>/<repo>-docs-<ticket_identifier>`
3. Write pending comments to `/tmp/marvin-review-docs-<identifier>.json`
4. Insert `review_runs` row with `ticket_linear_id = 'docs-<identifier>'` and `status = 'queued'`
5. Queue reviewer in spawn_queue

---

## 9. Spawn review teammates

**Re-check available slots.**

For each ticket where `review_status = 'pending_review'`:

**Check slots first**. If `SLOTS <= 0`, leave `pending_review`, increment `concurrency_deferred`, skip.

1. **Check no active review run** (`status IN ('running', 'queued')` for this `ticket_linear_id`). Skip if exists.

2. **Ensure worktree exists** — re-create if cleaned up:
```bash
if [ ! -d "<worktree_path>" ]; then
  cd <repo_path>
  git fetch origin main
  git worktree add "<worktree_path>" -b "<branch_name>" "origin/<branch_name>" 2>/dev/null || \
    git worktree add "<worktree_path>" "<branch_name>"
fi
```

3. **Write pending comments to temp JSON**:
```
# [STATE: update review comment status]
```

4. **Insert `review_runs` row** (with `status = 'queued'` — the orchestrator will set `'running'` when it actually spawns the worker). Explicitly pass `status`:
```
# [STATE: update state]
```

5. **Set `review_status = 'review_in_progress'`**:
```
# [STATE: update state]
```

6. **Queue reviewer** in spawn_queue:
```
# [STATE: update state]
```
Prompt includes: `linear_id`, `identifier`, `pr_number`, `repo`, `target_repo`, `worktree_path`, `branch_name`, `comments_json_path`, `repo_path`. References `/marvin-review`.

Increment `review`, decrement `SLOTS`.

---

## 10. Undraft ready PRs

Draft PRs that are ready for review:
```
# [STATE: update state]
```

For each, also verify no active review in tickets table:
```
# [STATE: update state]
```
If count > 0, skip.

Otherwise:
```bash
gh pr ready <pr_number> --repo <github_org>/<repo>
```
```
# [STATE: update state]
```
Increment `undrafted`.

---

## 11. Spawn documentation teammates

**Re-check available slots.**

Find knowledge files from completed executors:
```bash
for knowledge_file in /tmp/marvin-knowledge-GM-*.json; do
  [ -f "$knowledge_file" ] || continue
  # Extract: identifier, target_repo, repo_path, branch_name
done
```

For each knowledge file:

1. **Skip** if doc_run already exists for this `ticket_identifier`.

2. **Check actionable content**: `suggested_updates` array must be non-empty. If empty, skip and record as `status = 'skipped'`:
```
# [STATE: update state]
```

3. **Check slots**. If `SLOTS <= 0`, increment `concurrency_deferred`, skip (knowledge file persists for next cycle).

4. **Insert doc_run** (with `status = 'queued'` — the orchestrator will set `'running'` when it actually spawns the worker):
```
# [STATE: update state]
```

5. **Queue docs** in spawn_queue:
```
# [STATE: update state]
```
Prompt includes: `identifier`, `target_repo`, `repo_path`, `knowledge_path`, `original_pr_number`, `original_branch`. References `/marvin-docs`.

Decrement `SLOTS`, increment `docs`.

---

## 12. Log events

For significant actions, log to `cycle_events`:
```
# [STATE: update state]
```

---

## Output

Print a single summary line and exit:
```
PR: polled=<N> rebase=<N> ci_fix=<N> audit=<N> review=<N> undrafted=<N> docs=<N> concurrency_deferred=<N>
```

## Safety rules

- **Never create tickets in Linear** — only update existing ones
- Never merge PRs — only undraft when conditions are met
- Never deploy anything
- Never modify main directly — always use worktrees branching from `origin/main`
- Always unset upstream tracking on new worktree branches
- Always push with explicit refspec (`HEAD:refs/heads/<branch>`) — never rely on upstream tracking

## Constraints

- Never commit to main/master — always verify branch before committing
- Never force push
- Always create draft PRs
- Run tests before committing

## Environment

- Working directory: {worktree_path}
- Branch: {branch_name}
- Repository: {target_repo}
