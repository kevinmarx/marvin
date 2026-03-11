<!-- Generated from skills/reassign.md by harness/codex.ts — DO NOT EDIT DIRECTLY -->

# Task: Reassign

## Instructions

# Reassign — reassign a ticket based on CODEOWNERS

Reassign a Linear ticket to the person or team listed in CODEOWNERS for the affected path. Only called when the cycle has confirmed a specific CODEOWNERS entry exists (not just the default team).

> Context: See helpers/context-worker.md

## Inputs

- `linear_id`: Linear issue UUID
- `identifier`: e.g. GM-1234
- `title`: ticket title
- `target_repo`: repo name (from config `repos` keys)
- `affected_paths`: JSON array of likely file paths
- `complexity`: triage complexity score (1-5)
- `route_reason`: why this was routed to reassignment
- `codeowner`: the CODEOWNERS entry (person or team handle)

## Workflow

### Step 1: Resolve CODEOWNERS handle to Linear user

Use `list_users` Linear tool with `team: "<team from config>"` to get the team roster.

Match the CODEOWNERS handle (GitHub username or team name) to a Linear user by:
1. GitHub username match to Linear display name or email
2. If it's a team handle (e.g. `@org/specific-team`), find the team lead or first member

**Fallback**: If no Linear user can be matched → fall back to execute. Update the ticket route to `execute` and return.

### Step 2: Add discovery comment

Post a comment on the Linear ticket using `create_comment`:

```
🤖 Marvin triage notes:

**Complexity**: {complexity}/5
**Assigned to**: {assignee_name} (via CODEOWNERS)
**Affected areas**: {paths}
**Routing reason**: {route_reason}
```

### Step 3: Reassign

**Pre-check**: Only reassign tickets in an unstarted state (Todo, Backlog). If the ticket is already "In Progress" or "In Review", skip reassignment — someone is actively working on it.

Use `save_issue` to reassign:
- `id`: the Linear issue ID
- `assignee`: the chosen user's ID or email

### Step 4: Update state DB

```
# [STATE: update state]
```

## Error handling

If reassignment fails for any reason, fall back to execute — the agent team should attempt it.

## Constraints

- Never commit to main/master — always verify branch before committing
- Never force push
- Always create draft PRs
- Run tests before committing

## Environment

- Working directory: {worktree_path}
- Branch: {branch_name}
- Repository: {target_repo}
