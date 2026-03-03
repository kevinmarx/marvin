# /marvin-reassign — Reassign a ticket based on CODEOWNERS

You are reassigning a Linear ticket to the person or team listed in CODEOWNERS for the affected path.

**This command should only be called when the cycle has confirmed a specific CODEOWNERS entry exists for the affected path.** If there's no specific entry (just the default CODEOWNERS team), this ticket should go to execute instead.

## Input

You will receive these arguments (passed as context from /marvin-cycle):
- `linear_id`: Linear issue UUID
- `identifier`: e.g. GM-1234
- `title`: ticket title
- `target_repo`: the target repo name (from config `repos` keys)
- `affected_paths`: JSON array of likely file paths
- `complexity`: triage complexity score (1-5)
- `route_reason`: why this was routed to reassignment
- `codeowner`: the CODEOWNERS entry (person or team handle)

## Step 1: Resolve the CODEOWNERS handle to a Linear user

Use the `list_users` Linear tool with `team: "<team from config>"` to get the team roster.

Match the CODEOWNERS handle (GitHub username or team name) to a Linear user by:
1. GitHub username match to Linear display name or email
2. If it's a team handle (e.g. `@org/specific-team`), find the team lead or first member

If no Linear user can be matched, fall back to execute — update the ticket route to `execute` and return.

## Step 2: Add discovery comment

Add a comment to the Linear ticket using `create_comment`:

```
🤖 Marvin triage notes:

**Complexity**: {complexity}/5
**Assigned to**: {assignee_name} (via CODEOWNERS)
**Affected areas**: {paths}
**Routing reason**: {route_reason}
```

## Step 3: Reassign

**Pre-check**: Only reassign tickets that are in an unstarted state (Todo, Backlog). If the ticket is already "In Progress" or "In Review", skip reassignment — someone is actively working on it.

Use `update_issue` to reassign the ticket:
- `id`: the Linear issue ID
- `assignee`: the chosen user's ID or email

## Step 4: Update state DB

```
sqlite3 ~/.marvin/state/marvin.db "UPDATE tickets SET status = 'reassigned', assigned_to = '<user_id>', assigned_to_name = '<user_name>', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';"
```

## Error handling

If reassignment fails for any reason, fall back to execute — the agent team should attempt it.
