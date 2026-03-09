# Review — address PR review feedback

Reviewer teammate: address PR review comments on an existing draft PR. Make targeted changes, push additional commits, and reply to each comment via the GitHub API.

> Context: See helpers/context-worker.md

## Inputs

- `linear_id`: Linear issue UUID
- `identifier`: e.g. GM-1234
- `pr_number`: GitHub PR number
- `repo`: full repo name (e.g. `<github_org>/<target_repo>`)
- `target_repo`: short repo name (from config `repos` keys)
- `worktree_path`: absolute path to the worktree
- `branch_name`: git branch name
- `comments_json_path`: path to temp JSON file with pending review comments
- `repo_path`: absolute path to the main repo

## Workflow

### Phase 1: Sync worktree

> See helpers/phase-checkpoint.md — table: `review_runs`, role: `reviewer`
> See helpers/branch-safety.md

```bash
cd <worktree_path>
git fetch origin <branch_name>
git pull origin <branch_name>
```

### Phase 2: Understand context

1. **Read the PR diff**:
```bash
gh pr diff <pr_number> --repo <repo>
```

2. **Read the PR description**:
```bash
gh pr view <pr_number> --repo <repo> --json body,title
```

3. **Read the repo's `.claude/CLAUDE.md`** for conventions

4. **Read review comments** from `<comments_json_path>`. Each comment has:
   - `comment_id`: GitHub comment ID
   - `author`: who left the comment
   - `body`: the comment text
   - `path`: file path (null for top-level)
   - `line`: line number (null for top-level)
   - `thread_node_id`: GraphQL node ID for the thread

### Phase 3: Address each comment

For each comment, categorize and act:

#### No change needed
If the comment is a question, acknowledgment, or the code is already correct:
- Reply explaining reasoning:
```bash
gh api repos/<repo>/pulls/<pr_number>/comments/<comment_id>/replies \
  -f body="<response>"
```
- **Resolve the thread**:
```bash
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<thread_node_id>"}) { thread { isResolved } } }'
```

#### Code change needed
If the reviewer is requesting a change:
1. Read the relevant file(s) in the worktree
2. Make the change using Edit/Write tools
3. Track the change for the commit message
4. Reply describing what changed:
```bash
gh api repos/<repo>/pulls/<pr_number>/comments/<comment_id>/replies \
  -f body="Fixed — <brief description>. See upcoming commit."
```
5. **Resolve the thread**

#### Out of scope
If the comment requests an architectural change beyond the PR's scope:
```bash
gh api repos/<repo>/pulls/<pr_number>/comments/<comment_id>/replies \
  -f body="This is outside the scope of this PR. It would be better addressed in a separate ticket."
```
Mark as `skipped` in state DB. **Do NOT resolve out-of-scope threads** — leave them for the reviewer.

### Phase 4: Test

Run relevant tests after all changes:
- Go: `cd <worktree_path>/<app_dir> && go test ./...`
- Ruby: `cd <worktree_path>/<app_dir> && bundle exec rspec`
- Terraform: `cd <worktree_path> && terraform fmt && terraform validate`

Fix test failures before proceeding.

### Phase 5: Commit and push

> See helpers/branch-safety.md — re-check before committing

If any code changes were made:

```bash
cd <worktree_path>
git add -A
git commit -m "$(cat <<'EOF'
Address PR review feedback

- <bullet summary of each change>

Co-Authored-By: Marvin (Claude Code) <noreply@anthropic.com>
EOF
)"
git push origin HEAD:refs/heads/<branch_name>
```

Capture commit SHA: `git rev-parse HEAD`

### Phase 6: Update state DB

1. **Mark comments as addressed/skipped**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE review_comments
  SET status = 'addressed',
      processed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      response_body = '<response>',
      commit_sha = '<sha>'
  WHERE comment_id = <comment_id>;
"
```
Use `status = 'skipped'` for out-of-scope comments.

2. **Update the review run**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE review_runs
  SET status = 'completed',
      finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      comments_addressed = <count>,
      commits_pushed = <0_or_1>
  WHERE ticket_linear_id = '<linear_id>'
    AND status = 'running';
"
```

3. **Reset ticket review status**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets
  SET review_status = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<linear_id>';
"
```

## Safety rules

- Never modify files outside the scope of review comments
- Never force-push — only regular `git push`
- Never merge the PR — leave it as-is
- Always resolve threads after replying — except out-of-scope (leave open)
- If a comment is ambiguous or unsafe, reply asking for clarification and mark as `skipped`

## Error handling

On failure:
1. Update review run: `status = 'failed'`, `error = '<description>'`
2. Leave ticket `review_status` as-is so orchestrator retries next cycle
3. Report error to orchestrator
