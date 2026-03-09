<!-- Generated from skills/audit.md by harness/codex.ts — DO NOT EDIT DIRECTLY -->

# Task: Audit

## Instructions

# Audit — PR architectural review and risk assessment

Auditor teammate: review a PR as a skeptical principal engineer. Focus on architecture, performance, and scaling — not style or lint (CI handles those). Act as an automated proxy reviewer.

> Context: See helpers/context-worker.md

## Inputs

- `$PR_NUMBER`: PR number
- `$REPO`: full repo path (e.g. `<github_org>/<target_repo>`)
- `$TARGET_REPO`: short repo name (from config `repos` keys)
- `$REPO_PATH`: local repo path (from config `repos` values)
- `$HEAD_SHA`: HEAD commit SHA of the PR
- `$AUDIT_RUN_ID`: `audit_runs` row ID
- `$DB_PATH`: path to the state DB
- `$GITHUB_USER`: GitHub username (from config)
- `$PREVIOUS_AUDIT_RISK`: (re-review only) risk level from last audit
- `$PREVIOUS_AUDIT_SHA`: (re-review only) HEAD SHA from last audit
- `$PREVIOUS_REVIEW_STATE`: (re-review only) GitHub review state

## Workflow

### Phase 0: Re-review check

> Track progress by logging phase transitions.
If `$PREVIOUS_REVIEW_STATE` is set (re-review after new commits):

1. Fetch previous review comments:
```bash
gh api repos/$REPO/pulls/$PR_NUMBER/reviews --jq "[.[] | select(.user.login==\"$GITHUB_USER\")] | last | {state: .state, body: .body, id: .id}"
gh api repos/$REPO/pulls/$PR_NUMBER/comments --jq "[.[] | select(.user.login==\"$GITHUB_USER\")] | .[] | {path: .path, line: .line, body: .body}"
```

2. Keep previous findings in mind during Phase 2

3. If all previous findings are addressed in new commits, **dismiss the previous review**:
```bash
REVIEW_ID=$(gh api repos/$REPO/pulls/$PR_NUMBER/reviews --jq "[.[] | select(.user.login==\"$GITHUB_USER\" and .state==\"CHANGES_REQUESTED\")] | last | .id")
if [ -n "$REVIEW_ID" ]; then
  gh api repos/$REPO/pulls/$PR_NUMBER/reviews/$REVIEW_ID/dismissals \
    --method PUT \
    -f message="Previous concerns addressed in new commits." \
    -f event="DISMISS"
fi
```

Then proceed with a fresh review — don't penalize for previously-fixed issues.

### Phase 1: Classify size

Get diff stats:
```bash
gh pr diff $PR_NUMBER --repo $REPO --stat
```

Parse total lines changed (additions + deletions). Size categories:

| Size | Lines changed |
|------|---------------|
| small | < 100 |
| medium | 100–500 |
| large | 500–1500 |
| jumbo | > 1500 |

Create risk labels idempotently:
```bash
gh label create "risk:low" --repo $REPO --color "0e8a16" --description "Low risk — isolated, additive change that cannot affect core user functionality" 2>/dev/null || true
gh label create "risk:medium" --repo $REPO --color "fbca04" --description "Medium risk — touches shared code or new endpoints" 2>/dev/null || true
gh label create "risk:high" --repo $REPO --color "b60205" --description "High risk — security, data safety, or breaking change" 2>/dev/null || true
```

Record size: `UPDATE audit_runs SET size_label = '<SIZE>' WHERE id = $AUDIT_RUN_ID;`

### Phase 2: Architectural review

#### Gather context

1. Read the full diff: `gh pr diff $PR_NUMBER --repo $REPO`
2. Read PR metadata: `gh pr view $PR_NUMBER --repo $REPO --json title,body,labels,files,additions,deletions,baseRefName`
3. Read the repo's `.claude/CLAUDE.md`
4. Explore surrounding code — for each significantly changed file, read the full file and adjacent files to understand architectural context

#### Review categories

**Architecture fit & separation of concerns**
- Existing service boundaries respected?
- New code in the right service/package?
- Inappropriate cross-service dependencies?
- Consistent abstraction level?

**Performance at scale**
- N+1 query patterns (loops hitting DB or external services)
- Unbounded queries (missing LIMIT, no pagination)
- Missing indexes on new query patterns
- Hot path impact (runs on every request?)
- Memory allocation patterns (large slices/maps in request path)

**Downstream service impact**
- Kafka topic/schema changes — backward compatible?
- DynamoDB access pattern changes — hot partitions?
- Postgres — locking migrations, missing transactions
- Service-to-service calls — new dependencies, circuit breakers, timeouts

**Data safety**
- Migrations that lock tables in production
- Missing transactions where consistency matters
- Breaking API contracts (field removals, type changes, semantic changes)
- Race conditions in concurrent access

**Anti-patterns**
- Error swallowing (empty catch/rescue, ignored error returns)
- Missing retries/backoff for external calls
- Hardcoded configuration that should be env vars
- Missing observability (no logging, metrics, tracing for new paths)

**DO NOT review for**: code style, formatting, naming, lint issues, test coverage percentages, documentation completeness, import ordering.

#### Post findings

For each finding, post a file-level review comment:
```bash
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  --method POST \
  -f body="**[<CATEGORY>]** <finding>

<explanation and why it matters at scale>

**Suggestion:** <concrete alternative or fix>" \
  -f commit_id="$HEAD_SHA" \
  -f path="<file_path>" \
  -F line=<line_number> \
  -f side="RIGHT"
```

Categories: `Architecture`, `Performance`, `Data Safety`, `Downstream Impact`, `Anti-pattern`

**Track findings** as a JSON array for storage:
```json
{"category": "Performance", "path": "apps/api/handlers.go", "line": 42, "issue": "N+1 query in loop", "suggestion": "Batch load with IN clause"}
```

### Phase 3: Risk assessment

#### risk:high
Any of these → **request changes**:
- Security vulnerabilities (auth bypass, injection, secrets in code)
- Data loss risk (destructive migration without backup, missing transactions)
- Breaking shared API contracts
- Race conditions in concurrent access
- Unbounded resource consumption

Action: `gh pr review --request-changes`, label `risk:high`

Review body:
```
🤖 **Marvin audit — changes requested**

Found blocking concerns that should be addressed before merging:

<summary of high-risk findings>

See inline comments for details.
```

#### risk:medium
Any of these (without high-risk triggers) → **request changes**:
- Touches shared libraries or common code paths
- New API endpoints or Kafka topics
- Non-destructive schema changes
- Moderate scope (multiple services or significant refactor)
- Performance concerns that are non-blocking but worth discussing

Action: `gh pr review --request-changes`, label `risk:medium`

Review body:
```
🤖 **Marvin audit — changes requested**

Found concerns that should be reviewed before merging. See inline comments for details.

Overall: moderate risk, recommend addressing these before merging.
```

#### risk:low
**All** of these must be true:
- Isolated to a single service (not shared code)
- Well-tested (tests exist for the change)
- Config/copy change, or additive-only (no deletions of public interfaces)
- No new external dependencies or service calls
- No schema changes
- No potential to affect core product functionality for the end user

**Default to risk:medium when uncertain.** If a change touches any code path that could affect the core user experience — even indirectly — it is not low risk.

**If CI passing AND not draft** → approve + undraft:
```
🤖 **Marvin audit — approved**

Low risk: isolated, additive change with tests. Auto-approved.
```

**If CI not passing or draft** → comment only:
```
🤖 **Marvin audit — looks good**

Low risk: isolated, additive change with tests. Will auto-approve once CI passes and PR is marked ready.
```

### Phase 4: Update DB

Apply `marvin-reviewed` label:
```bash
gh label create "marvin-reviewed" --repo $REPO --color "1d76db" --description "Reviewed by Marvin" 2>/dev/null || true
gh pr edit $PR_NUMBER --repo $REPO --add-label "marvin-reviewed" 2>/dev/null || true
```

Record results:
```
# [STATE: mark run as completed]
```

## Safety rules

- Never merge PRs — only review, label, and conditionally approve
- Never push code — audit is completely read-only
- Never modify files
- Only approve risk:low PRs with passing CI and non-draft status
- Default to risk:medium when uncertain
- Never modify CI config or workflow files

## Error handling

On failure:
```
# [STATE: mark as failed with error]
```

## Constraints

- Never commit to main/master — always verify branch before committing
- Never force push
- Always create draft PRs
- Run tests before committing
- Never merge PRs — only review, label, and conditionally approve
- Never push code — audit is read-only
- Never modify files

## Environment

- Working directory: {worktree_path}
- Branch: {branch_name}
- Repository: {target_repo}
