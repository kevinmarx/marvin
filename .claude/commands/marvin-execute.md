# /marvin-execute — Execute a ticket end-to-end

You are a teammate agent executing a single Linear ticket. You have full tool access — you can read, write, edit files, and run bash commands. You do all the work yourself: explore, plan, implement, test, commit, push, and create a draft PR.

## Input

You will receive these arguments from the orchestrator:
- `linear_id`: Linear issue UUID
- `identifier`: e.g. GM-1234
- `title`: ticket title
- `description`: full ticket description
- `target_repo`: the target repo name (from config `repos` keys)
- `affected_paths`: JSON array of likely file paths
- `implementation_hint`: brief approach suggestion from triage
- `worktree_path`: absolute path to the worktree (already created)
- `branch_name`: git branch name (already created)
- `repo_path`: absolute path to the main repo

## Phase checkpoint helper

At the start of each phase, run BOTH of these statements — update `last_phase` for liveness tracking AND log to `cycle_events` so the dashboard shows real-time progress:

```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = '<PHASE_NAME>', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> executor: entering phase <PHASE_NAME>');
"
```

**Periodic heartbeat**: During long-running phases (especially `explore`, `implement`, and `test`), re-run the UPDATE (not the INSERT) every ~10 minutes to signal liveness. You don't need to change `last_phase` — just re-run it to refresh `last_phase_at` and `updated_at`.

**CRITICAL**: You MUST run this checkpoint SQL at the start of EVERY phase below. The ops phase uses `last_phase` and `updated_at` to detect stuck workers. If you don't update these, your ticket will be reaped as stale after 120 minutes even if you're still working.

## Pre-check: Existing PRs

**Run this checkpoint FIRST**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'pre-check', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> executor: entering phase pre-check');
"
```

Before doing any work, check if there's already an open PR that addresses this ticket:

```bash
cd <repo_path>
gh pr list --state open --search "<identifier>" --json number,title,url
```

Also check by branch name pattern:
```bash
gh pr list --state open --head "<branch_name>" --json number,title,url
```

If an open PR exists that addresses this ticket:
1. Update state DB: `status = 'done'`, `pr_url = '<existing_pr_url>'`
2. Report back to the orchestrator that an existing PR was found
3. Return early

## Phase 1: Explore

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'explore', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> executor: entering phase explore');
"
```

Work in the worktree directory (`cd <worktree_path>`).

**Branch safety check** — before doing ANY work, verify you're on the correct branch:
```bash
cd <worktree_path>
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "FATAL: On branch $CURRENT_BRANCH — refusing to proceed. Must be on a feature branch."
  exit 1
fi
```
If this check fails, update the state DB with `status = 'failed'` and `error = 'Worktree was on main branch'`, and stop immediately.

Read the repo's `.claude/CLAUDE.md` first for conventions.

**Extract images**: If the ticket description contains images (screenshots, mockups, diagrams), use the `extract_images` Linear MCP tool to view them. Pass the ticket `description` as the `markdown` parameter. These images often contain critical context — UI mockups, error screenshots, architecture diagrams — that inform the implementation.

Explore the codebase to understand:
1. Which exact files need to change — use `affected_paths` as starting points
2. What patterns exist in similar code nearby
3. What tests exist for this area
4. Any constraints or conventions

Use Glob, Grep, and Read tools to explore. Be thorough but focused.

## Phase 2: Plan

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'plan', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> executor: entering phase plan');
"
```

Based on your exploration, create an implementation plan:
1. Which files to create/modify
2. What changes to make in each file (be specific)
3. What tests to write/update
4. What commands to run to verify

**Complexity gate**: If the change would require more than ~200 lines across more than 6-8 files, and you genuinely can't see a path to a working implementation, update the state DB with `status = 'failed'` and `error = 'Complexity exceeded expectations'`, add a comment to the Linear ticket explaining why, and stop.

## Phase 3: Implement

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'implement', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> executor: entering phase implement');
"
```

Make the changes. Use Edit and Write tools to modify files in the worktree.

After making changes, run tests:

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'test', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> executor: entering phase test');
"
```

- For Go apps: `cd <worktree_path>/<app_dir> && go test ./...`
- For Ruby apps: `cd <worktree_path>/<app_dir> && bundle exec rspec` (or `docker compose run <service> bundle exec rspec` if docker-compose.yaml exists)
- For Terraform: `cd <worktree_path> && terraform fmt && terraform validate`

If tests fail, fix them. If you can't fix them after 2 attempts, report the failure.

## Phase 4: Commit, Push, PR

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'commit-push', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> executor: entering phase commit-push');
"
```

After successful implementation:

**Branch safety re-check** — verify you're still on the feature branch before any git write operations:
```bash
cd <worktree_path>
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "FATAL: On branch $CURRENT_BRANCH — refusing to commit/push."
  sqlite3 ~/.marvin/state/marvin.db "UPDATE tickets SET status = 'failed', error = 'Branch safety: was on main at commit time' WHERE linear_id = '<linear_id>';"
  exit 1
fi
echo "Branch safety OK: on $CURRENT_BRANCH"
```

1. **Stage and commit**:
```bash
cd <worktree_path>
git add -A
git commit -m "$(cat <<'EOF'
<identifier>: <title>

<brief description of what changed>

Co-Authored-By: Marvin (Claude Code) <noreply@anthropic.com>
EOF
)"
```

2. **Push** (explicit refspec to avoid pushing to main via upstream tracking):
```bash
git push -u origin HEAD:refs/heads/<branch_name>
```

3. **Create draft PR**:

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'pr-creation', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> executor: entering phase pr-creation');
"
```
```bash
cd <worktree_path>
gh pr create --draft --title "<identifier>: <title>" --body "$(cat <<'EOF'
## Summary

Automated implementation for [<identifier>](<linear_url>): <title>

## Changes

<brief summary of what was changed and why>

## Test plan

- [ ] Tests pass locally
- [ ] Code review by human
- [ ] Verify on staging

---
<img src="https://github.com/user-attachments/assets/6dafa5b7-2b93-41da-ad3c-3881d60b7a54" width="20" /> Generated by Marvin
EOF
)"
```

4. **Capture PR URL**:
```bash
cd <worktree_path>
gh pr view --json url,number -q '.url + " " + (.number | tostring)'
```

5. **Update Linear** — use `create_comment` on the Linear issue:
   - Comment: "Marvin created a draft PR: <pr_url>"
   - Move the ticket state to "In Review" using `update_issue`

6. **Update state DB**:
```bash
sqlite3 ~/.marvin/state/marvin.db "UPDATE tickets SET status = 'done', pr_url = '<pr_url>', pr_number = <pr_number>, executed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';"
```

7. **Record knowledge for documentation follow-up**:

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'knowledge-capture', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> executor: entering phase knowledge-capture');
"
```

During phases 1-3, you learned things about the codebase that aren't documented. Before finishing, write a knowledge summary to a temp file so a documentation teammate can create a follow-up PR.

```bash
cat > /tmp/marvin-knowledge-<identifier>.json << 'KNOWLEDGE_EOF'
{
  "identifier": "<identifier>",
  "target_repo": "<target_repo>",
  "worktree_path": "<worktree_path>",
  "branch_name": "<branch_name>",
  "repo_path": "<repo_path>",
  "services_touched": ["<list of service directories worked in>"],
  "findings": {
    "architecture": "<what you learned about how this area works — data flow, service interactions, key abstractions>",
    "conventions": "<coding patterns, naming conventions, or practices you noticed that aren't in CLAUDE.md>",
    "build_and_test": "<how to build/test this area if not obvious — special commands, fixtures, env setup>",
    "gotchas": "<non-obvious behaviors, edge cases, or things that tripped you up>",
    "missing_docs": "<what documentation is missing or outdated for this area>"
  },
  "suggested_updates": [
    {
      "file": "<path relative to repo root, e.g. .claude/CLAUDE.md or apps/push-v2/README.md>",
      "type": "<update|create>",
      "section": "<which section to add to, or null for new file>",
      "content_summary": "<what should be added, in 1-2 sentences>"
    }
  ]
}
KNOWLEDGE_EOF
```

Be specific and actionable in `suggested_updates` — a documentation teammate will use this to create a follow-up PR. Only include findings that would genuinely help the next person working in this area. Skip if you didn't learn anything non-obvious.

## Error handling

If any phase fails:
1. Update state DB: `status = 'failed'`, `error = '<description>'`
2. Add comment to Linear ticket explaining the failure using `create_comment`
3. Report the error back to the orchestrator
