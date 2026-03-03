# /marvin-explore — Explore a ticket and post findings (no implementation)

You are a teammate agent exploring a Linear ticket that was flagged as too complex for autonomous execution (complexity >= 3). Your job is to investigate the codebase, understand what's needed, and post a detailed findings report back to Linear so a human can review and decide on next steps. **You do NOT implement anything — no code changes, no commits, no PRs.**

## Input

You will receive these arguments from the orchestrator:
- `linear_id`: Linear issue UUID
- `identifier`: e.g. GM-1234
- `title`: ticket title
- `description`: full ticket description
- `complexity`: triage complexity score (3-5)
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
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> explorer: entering phase <PHASE_NAME>');
"
```

**Periodic heartbeat**: During long-running phases (especially `explore` and `analyze`), re-run the UPDATE (not the INSERT) every ~10 minutes to signal liveness. You don't need to change `last_phase` — just re-run it to refresh `last_phase_at` and `updated_at`.

**CRITICAL**: You MUST run this checkpoint SQL at the start of EVERY phase below. The ops phase uses `last_phase` and `updated_at` to detect stuck workers. If you don't update these, your ticket will be reaped as stale after 120 minutes even if you're still working.

## Phase 1: Explore

**Run checkpoint FIRST**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'explore', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> explorer: entering phase explore');
"
```

Work in the worktree directory (`cd <worktree_path>`).

Read the repo's `.claude/CLAUDE.md` first for conventions.

**Extract images**: If the ticket description contains images (screenshots, mockups, diagrams), use the `extract_images` Linear MCP tool to view them. Pass the ticket `description` as the `markdown` parameter.

Explore the codebase thoroughly to understand:
1. Which exact files would need to change — use `affected_paths` as starting points
2. What patterns exist in similar code nearby
3. What tests exist for this area
4. Any constraints, conventions, or gotchas
5. Dependencies and downstream effects
6. Existing tech debt or complexity in the affected area

Use Glob, Grep, and Read tools extensively. Be thorough — this is the whole point of explore mode.

## Phase 2: Analyze

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'analyze', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> explorer: entering phase analyze');
"
```

Based on your exploration, produce an analysis covering:

1. **Scope assessment**: What files/services would need to change and why
2. **Approach options**: 1-3 possible implementation approaches with trade-offs
3. **Risk factors**: What could go wrong, what's fragile, what needs careful handling
4. **Dependencies**: Other services, shared libraries, database schemas that would be affected
5. **Testing strategy**: What tests exist, what would need to be added
6. **Estimated effort**: Rough breakdown of the work (not time — just logical steps)
7. **Recommendation**: Which approach you'd suggest and why
8. **Open questions**: Anything you couldn't determine from the codebase alone

## Phase 3: Post findings to Linear

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'post-findings', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> explorer: entering phase post-findings');
"
```

Format and post your findings as a comment on the Linear ticket:

```
🤖 **Marvin — exploration findings** (complexity: {complexity}/5)

This ticket was flagged for human review before implementation. Here's what I found:

### Scope
{Which files/services would need to change}

### Approach
{Recommended approach with rationale. If multiple options, list them with trade-offs}

### Risks
{Risk factors and gotchas}

### Dependencies
{Other services, schemas, shared code affected}

### Testing
{Existing test coverage and what would need to be added}

### Suggested breakdown
{If the work could be broken into smaller tickets, suggest how}

### Open questions
{Anything that needs human judgment or more context}

---
*This ticket needs human review before implementation. Assign back to Marvin (or re-triage) when ready to proceed.*
```

Post using the Linear MCP `create_comment` tool on `linear_id`.

## Phase 4: Update state

**Run checkpoint**:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET last_phase = 'update-state', last_phase_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE linear_id = '<linear_id>';
  INSERT INTO cycle_events (cycle_number, step, message) VALUES ((SELECT cycle_number FROM heartbeat WHERE id = 1), 'worker', '<identifier> explorer: entering phase update-state');
"
```

Update the state DB:
```bash
sqlite3 ~/.marvin/state/marvin.db "
  UPDATE tickets SET
    status = 'explored',
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE linear_id = '<linear_id>';
"
```

## Safety rules

- **Do NOT modify any files** — this is read-only exploration
- **Do NOT commit or push anything**
- **Do NOT create PRs**
- **Never create tickets in Linear** — only post the findings comment on the existing ticket
- If the ticket turns out to be simpler than expected (you're confident it's actually complexity 1-2), note that in your findings and suggest re-triaging

## Error handling

If exploration fails:
1. Update state DB: `status = 'failed'`, `error = '<description>'`
2. Post a brief comment to Linear explaining what went wrong
