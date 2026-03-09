<!-- Generated from skills/dt-phase-ops.md by harness/codex.ts — DO NOT EDIT DIRECTLY -->

# Task: Phase: DT Ops

## Instructions

# Phase: DT Ops — Housekeeping

You are a Deep Thought phase agent. Trim old data, reap stale scanner teammates, reconcile resolved findings, and record cycle stats. Then exit with a summary.

> Context: See helpers/context-dt.md

**Read config** from the path provided in the prompt (the `Config:` parameter). If no config path is provided, fall back to `config/deep-thought.json` (relative to the marvin repo root). Use `state_db` from config (default `~/.deep-thought/state/deep-thought.db`) as `DB_PATH`.

---

## 1. Trim old data

Keep cycle_events for 24 hours; old scan_runs for 7 days:
```
# [STATE: update state]
```

---

## 2. Reap stale scanner teammates

Read `stale_scanner_minutes` from `config.limits` (default 60).

Find scanner runs stuck in `running` beyond the timeout:

```
# [CHECKPOINT]
```

For each stale scanner run, use `last_phase` from the query (or `'unknown'` if null):

```
# [CHECKPOINT]
```

Log a `cycle_events` entry for each reaped scanner:
```
# [CHECKPOINT]
```

---

## 3. Reconcile resolved findings

Check if any tickets created by Deep Thought have been closed/cancelled/done in Linear. This prevents re-creating tickets for issues that have been addressed.

Query findings that have tickets:
```
# [STATE: update state]
```

For each finding with a ticket, check the ticket's state in Linear using `get_issue`:
- If the ticket is in a completed state (Done, Cancelled, Closed): mark the finding as resolved:
```
# [STATE: update state]
```

**Rate limit this check**: only check up to 20 findings per cycle to avoid hammering the Linear API.

---

## 4. Record cycle stats

Count activity from recent scan_runs:
```
# [STATE: update state]
```

---

## Output

When done, print a single summary line to stdout and exit:

```
OPS: reaped=<N> reconciled=<N> trimmed=<yes/no>
```

Where `<N>` is the total number of stale items reaped and findings reconciled. This summary is what the orchestrator sees — keep it short.

## Constraints

- Read-only codebase access — never modify code, only read
- Deduplicate findings by hash before creating tickets
- Only create tickets for findings with sufficient confidence
- All created tickets must be labeled appropriately

## Environment

- Working directory: {worktree_path}
- Branch: {branch_name}
- Repository: {target_repo}
