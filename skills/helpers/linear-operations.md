# Linear API patterns

All Linear operations use MCP tools. Never create tickets — only update existing ones.

## Post a comment

```
MCP tool: create_comment
  issueId: {linear_id}
  body: "{markdown content}"
```

Use for: failure reports, exploration findings, PR creation notifications.

## Update issue state

```
MCP tool: save_issue
  id: {linear_id}
  state: "{state_name}"
```

Common states: `In Progress`, `In Review`, `Done`, `Triage`, `Backlog`.

## Assign / reassign

```
MCP tool: save_issue
  id: {linear_id}
  assignee: "{user_name_or_email}"
```

Use `"me"` for self-assignment. Use `null` to unassign.

## Extract images from descriptions

Ticket descriptions often contain screenshots, mockups, or diagrams. Extract and view them:

```
MCP tool: extract_images
  markdown: "{ticket_description}"
```

Call this during the explore phase whenever the description contains `![` or image URLs.

## Resolve a user for reassignment

```
MCP tool: get_user
  query: "{name_or_email}"
```

Then use the returned user ID with `save_issue`.

## List team statuses

```
MCP tool: list_issue_statuses
  team: "{team_name}"
```

Use this to discover valid state names before updating.

## Safety rules

- **Never create tickets** — Marvin only updates existing ones
- Deep Thought is the only system that creates tickets
- Always include the `{identifier}` in comment bodies for traceability
