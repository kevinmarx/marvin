# Marvin — Autonomous Linear Ticket Triage & Execution System

> **NEVER commit or push directly to `main` on repos Marvin works on** (configured in `config.json`). All changes must go through a worktree branch (`<branch_prefix from config>/*`) and a draft PR. The marvin repo itself is fine to commit to main.

Marvin watches Linear for tickets on the configured team — both tickets assigned to the configured assignee and tickets tagged with the configured label (regardless of assignee). It polls triage, backlog, and unstarted states. For all tickets without a specific CODEOWNERS entry, Marvin assigns to the configured assignee and executes via an agent worker. For tickets with a specific CODEOWNERS entry, Marvin reassigns to the identified owner. Ambiguous tickets where the repo/area can't be determined are deferred.

## Architecture

Marvin has **two runtime modes** that share the same skills, tools, model router, and safety invariants:

1. **Autonomous mode** — overnight ticket processing via polling cycle (orchestrator)
2. **Assist mode** — real-time human-in-the-loop via WebSocket (realtime server)

### Dual runtime architecture

```
┌─────────────────────────────────────────────────────┐
│                 Coordination Layer                    │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐    │
│  │ SQLite   │  │ Config   │  │ Spawn Manager  │    │
│  │ State DB │  │ (JSON)   │  │ (fork-based)   │    │
│  └──────────┘  └──────────┘  └────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │ Safety Hooks                                  │   │
│  │ (branch check, concurrency limit, no-merge)   │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                    Agent Runtime                     │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐    │
│  │ Model    │  │ Tool     │  │ Context Window │    │
│  │ Router   │  │ Executor │  │ Manager        │    │
│  └────┬─────┘  └──────────┘  └────────────────┘    │
│       │                                              │
│  ┌────┴─────────────────────────────────────────┐   │
│  │ LiteLLM (multi-provider)                      │   │
│  │  ┌─────────┐  ┌───────────┐  ┌────────────┐  │   │
│  │  │ Claude  │  │ GPT-5     │  │ Gemini     │  │   │
│  │  │ Opus    │  │ Codex     │  │ 2.5 Pro    │  │   │
│  │  └─────────┘  └───────────┘  └────────────┘  │   │
│  │  ┌─────────┐  ┌───────────┐                   │   │
│  │  │ Claude  │  │ GPT-4o   │  (cost-optimized) │   │
│  │  │ Sonnet  │  │          │                    │   │
│  │  └─────────┘  └───────────┘                   │   │
│  └───────────────────────┬──────────────────────┘   │
│                          │                           │
│  ┌───────────────────────┴──────────────────────┐   │
│  │ Feedback Loop                                 │   │
│  │ (outcome tracking, human ratings, learned     │   │
│  │  routing weights per task×model)               │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  Tools: file_read, file_write, file_edit, bash,     │
│         glob, grep, linear_api, git, gh             │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                 Skills (portable)                    │
│                                                      │
│  execute, explore, review, ci_fix, audit, docs,     │
│  reassign, digest, orchestrator, phase_ops,          │
│  phase_triage, phase_pr                              │
└─────────────────────────────────────────────────────┘
```

### Autonomous mode (orchestrator)

The orchestrator (`runtime/src/orchestrator.ts`) runs a cycle loop, dispatching work to phase functions and spawning workers as child processes. After a configured number of cycles (default 48, ~24 hours), it exits cleanly and the wrapper script restarts it.

```
run-marvin.sh (restart loop)
  └─ npx tsx src/orchestrator-cli.ts
       │
       ├─ Phase 1: phaseOps() (inline function call)
       │    ├─ Reap stale workers via SpawnManager
       │    ├─ Trim old data (cycle_events, digests)
       │    ├─ Record cycle stats
       │    └─ Hourly digest
       │
       ├─ Phase 2: phaseTriage() (inline function call)
       │    ├─ Process dashboard reassess requests
       │    ├─ Poll Linear (assigned to me + Platform label)
       │    ├─ Filter & triage new tickets
       │    ├─ Route (execute/explore/reassign/defer)
       │    └─ Return SpawnRequests for workers
       │
       ├─ drainAndSpawn() → fork executor/explorer workers
       │
       ├─ Phase 3: phasePR() (inline function call)
       │    ├─ Poll open PRs, upsert into DB
       │    ├─ Auto-rebase behind PRs
       │    ├─ Detect CI failures, audit candidates, review comments
       │    └─ Return SpawnRequests for CI-fix/audit/review/docs workers
       │
       ├─ drainAndSpawn() → fork CI-fix/audit/review/docs workers
       │
       ├─ Self-restart check (exit after N cycles)
       └─ Sleep (cycle_interval_seconds, default 1800)
```

Workers are spawned as **child processes** via `child_process.fork()`. Each worker runs `agent.ts` with `SKILL` and `ARGS` env vars. Workers communicate back via Node IPC:
- `{ type: 'heartbeat', phase }` — liveness signal
- `{ type: 'complete', success }` — worker done
- `{ type: 'failed', error }` — worker failed

**Concurrency limit**: 8 concurrent workers max, enforced in-memory by SpawnManager.

### Assist mode (realtime server)

The realtime server (`runtime/src/realtime.ts`) runs a WebSocket server on port 7780. A human connects via the dashboard's Assist tab and interacts with agents in real time.

- Spawn agents on demand (any skill, any model)
- Stream agent output (tool calls, thinking, text) to the browser in real time
- Send messages to running agents (injected into conversation)
- Interrupt agents mid-execution

Both modes share the same skills, tools, model router, and safety invariants. The difference is who directs the work.

### Skills architecture

Skills are the **portable source of truth** for all agent behavior. They live in `skills/` and contain pure domain logic — what to do, not how to be an agent.

```
skills/
  execute.md         # Explore → plan → implement → test → commit → PR
  explore.md         # Investigate codebase → post findings (no implementation)
  review.md          # Address PR review comments → commit → push
  ci-fix.md          # Investigate CI failure → fix → test → push
  audit.md           # Classify size → architectural review → risk assess
  docs.md            # Read executor knowledge → update docs → PR
  reassign.md        # Reassign ticket via CODEOWNERS
  digest.md          # Executive summary of activity
  orchestrator.md    # Main cycle loop logic
  phase-ops.md       # Ops phase: reap, stats, digest, trim
  phase-triage.md    # Triage phase: poll, assess, route
  phase-pr.md        # PR phase: poll, rebase, CI-fix, audit, review, undraft
  helpers/
    phase-checkpoint.md   # SQL checkpoint patterns per worker type
    branch-safety.md      # Branch verification snippets
    git-operations.md     # Push refspec, worktree, rebase patterns
    error-handling.md     # DB update + Linear comment on failure
    test-selection.md     # Language-specific test commands
    linear-operations.md  # Linear API patterns
    github-operations.md  # GitHub CLI patterns
```

Skills compile to multiple harness formats via `harness/compile.ts`:
- **Claude Code**: `npx tsx harness/compile.ts --target claude-code` → `.claude/commands/*.md`
- **Codex**: `npx tsx harness/compile.ts --target codex` → `harness/output/codex/*.md`
- **Raw API**: the runtime itself (`runtime/src/agent.ts` + `runtime/src/skills.ts`)

> **Generated commands**: All `.claude/commands/marvin-*.md` files are now generated from skills. Do not edit them directly — edit the skill file and recompile.

### Smart model routing

The router (`runtime/src/router/router.ts`) picks the best frontier model for each task. Every task gets a top-tier thinking model — the question is *which one*.

**4-tier selection cascade**:
1. **Manual overrides** — human says "force Opus for Go" via dashboard
2. **Learned weights** — feedback data says Opus scores 0.85 for go_bugfix
3. **Language affinity** — static multipliers (e.g. Opus +30% for Go, GPT-5 +30% for TypeScript)
4. **Default routing** — static fallback

**Default routing table**:

| Task | Default model | Cost tier | Reason |
|------|--------------|-----------|--------|
| execute:explore | claude-opus | high | Deep codebase analysis |
| execute:plan | claude-opus | high | Architecture decisions |
| execute:implement | gpt5-codex | medium | Raw coding speed |
| execute:test | gpt5-codex | medium | Test generation |
| review | claude-opus | high | Understanding reviewer intent |
| ci_fix | claude-sonnet | low | Log parsing + targeted fixes |
| audit | gemini-pro | medium | Large context for full-PR review |
| explore | claude-opus | high | Deep analysis |
| docs | claude-sonnet | low | Writing, doesn't need frontier reasoning |
| triage | claude-sonnet | low | Structured JSON output from a rubric |
| phase_ops | gpt4o | low | Digest synthesis only |
| phase_triage | claude-sonnet | low | Triage judgment calls |
| phase_pr | gpt4o | low | Rarely needs model calls in v2 |

**Provider pool** (configured in `config.routing.providers`):

| Provider | LiteLLM model | Cost tier | Max context |
|----------|---------------|-----------|-------------|
| claude-opus | `anthropic/claude-opus-4` | high | 200K |
| gpt5-codex | `openai/gpt-5-codex` | medium | 128K |
| gemini-pro | `google/gemini-2.5-pro` | medium | 1M |
| claude-sonnet | `anthropic/claude-sonnet-4` | low | 200K |
| gpt4o | `openai/gpt-4o` | low | 128K |

### Feedback loop

Every agent run records structured outcomes in the `model_runs` table:
- **Automatic signals**: success, tests_passed, test_retries, ci_passed, pr_review_rounds, tokens_used, duration_seconds, tool_call_count
- **Human feedback** (via dashboard Models tab): human_rating (1-5), code_quality, correctness, efficiency, test_quality, notes

Composite score calculation (6 signals, weights sum to 1.0):
- human_rating: 0.30 (most important, falls back to success_rate)
- success_rate: 0.25
- ci_pass_rate: 0.15
- test_first_pass: 0.10
- review_efficiency: 0.10
- token_efficiency: 0.10

Confidence = min(sample_count / 20, 1.0). Learned weights take effect after 5+ runs per task type.

## Safety invariants

- Never create tickets in Linear — only update existing ones (comments, state changes, assignments)
- Never merge PRs — always create as draft, undraft only when CI passes and review comments are addressed
- Auto-approval only for risk:low PRs with passing CI (via audit workers)
- Never deploy anything
- Never modify main directly on target repos — always use worktrees branching from `origin/main`
- Always push with explicit refspec (`HEAD:refs/heads/<branch>`) — never rely on upstream tracking
- Always unset upstream tracking on new worktree branches to prevent accidental push to main
- Branch safety re-check before every commit/push in all worker skills
- Never force push
- Never read .env files
- Human review is always required before merging (except risk:low auto-approvals)

## State management

- SQLite database at `~/.marvin/state/marvin.db`
- Schema managed via numbered migrations in `schema/migrations/` — run `scripts/migrate.sh`
- Daily backups via `scripts/backup-db.sh` (7-day retention, safe concurrent access via SQLite `.backup`)
- All timestamps use `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` — never `datetime('now')`

### Database tables

| Table | Source | Purpose |
|-------|--------|---------|
| `tickets` | `001_initial.sql` | Core ticket tracking, triage results, execution status, PR info, defer fields |
| `runs` | `001_initial.sql` | Per-cycle stats (tickets found/triaged/executed/failed) |
| `digests` | `001_initial.sql` | Hourly digest history |
| `pull_requests` | `001_initial.sql` | All open PRs, CI/review/audit status, merge conflict detection, auto-rebase tracking |
| `review_comments` | `001_initial.sql` | Individual PR review comments with addressing status |
| `review_runs` | `001_initial.sql` | Review processing sessions |
| `ci_fix_runs` | `001_initial.sql` | CI fix attempt tracking per PR |
| `audit_runs` | `001_initial.sql` | Audit attempt tracking per PR, with `findings_json` |
| `schema_version` | `001_initial.sql` | Tracks applied migrations |
| `heartbeat` | `003_heartbeat.sql` | Singleton row: orchestrator liveness (cycle number, current step, last beat) |
| `cycle_events` | `003_heartbeat.sql` | Per-cycle event log for dashboard activity (capped at 500 rows) |
| `reassess_requests` | `004_reassess_queue.sql` | Dashboard → orchestrator queue for manual re-triage requests |
| `doc_runs` | `005_doc_runs.sql` | Documentation follow-up PR tracking |
| `spawn_queue` | `008_spawn_queue.sql` | Worker spawn requests (v1 only — v2 runtime uses in-memory SpawnManager) |
| `model_runs` | `012_model_feedback.sql` | Per-run model performance tracking for feedback loop |
| `routing_weights` | `012_model_feedback.sql` | Learned routing weights per task_type×language×model |
| `routing_overrides` | `012_model_feedback.sql` | Manual routing overrides (human forces a model for a task type) |

### Configuration

Config in `config/default.json` (see `config/example.json` for a template):

```json
{
  "team": "YourTeam",
  "assignee": "me",
  "repos": {
    "your-infra-repo": "/path/to/your-infra-repo",
    "your-main-repo": "/path/to/your-main-repo"
  },
  "worktree_root": "/path/to/worktrees",
  "complexity_threshold": 2,
  "confidence_threshold": 0.7,
  "digest_interval_minutes": 120,
  "state_db": "~/.marvin/state/marvin.db",
  "log_dir": "~/.marvin/logs",
  "backup_dir": "~/.marvin/backups",
  "github_org": "your-github-org",
  "github_user": "your-github-username",
  "linear_workspace_slug": "your-workspace",
  "branch_prefix": "users/your-username",
  "git_name": "Your Name",
  "git_email": "you@example.com",
  "plugins_dir": "/path/to/mcp-plugins",
  "marvin_repo_path": "/path/to/marvin",
  "labels": {
    "platform": "Platform"
  },
  "cycle_interval_seconds": 1800,
  "self_restart_after_cycles": 48,
  "limits": {
    "defer_max_followups": 3,
    "defer_min_interval_hours": 24,
    "defer_nudge_after_days": 7,
    "ci_fix_max_attempts": 5,
    "ci_fix_min_interval_minutes": 10,
    "ci_fix_max_files": 5,
    "executor_max_test_retries": 2,
    "stale_executor_minutes": 120,
    "stale_reviewer_minutes": 60,
    "stale_ci_fix_minutes": 30,
    "stale_auditor_minutes": 30,
    "stale_docs_minutes": 30,
    "rebase_max_attempts": 3,
    "rebase_min_interval_minutes": 10,
    "max_concurrent_workers": 8
  },
  "routing": {
    "providers": {
      "claude-opus": { "litellm_model": "anthropic/claude-opus-4", "enabled": true },
      "gpt5-codex": { "litellm_model": "openai/gpt-5-codex", "enabled": true },
      "gemini-pro": { "litellm_model": "google/gemini-2.5-pro", "enabled": true },
      "claude-sonnet": { "litellm_model": "anthropic/claude-sonnet-4", "enabled": true },
      "gpt4o": { "litellm_model": "openai/gpt-4o", "enabled": true }
    },
    "min_runs_for_learned_routing": 5,
    "confidence_threshold": 0.7
  }
}
```

### Dashboard

Web UI at `http://localhost:7777` (run `scripts/dashboard.py`):
- **Health banner**: Green (pulsing) / yellow / red based on orchestrator heartbeat age
- **Tabs**: Tickets, Teammates, Models, Work, Digests, Log, Assist
- **Models tab**: Unrated runs for human feedback, routing weights table, performance stats, manual overrides
- **Assist tab**: WebSocket client connecting to realtime server on `:7780` — spawn agents, stream output, send messages, interrupt
- **Re-assess button** (↻) on each ticket to queue manual re-triage
- Auto-refreshes every 60s

## Runtime directory structure

```
runtime/
  src/
    agent.ts            # Core agent loop (skill → model → tools → repeat)
    agent-events.ts     # Streaming agent loop with EventEmitter for realtime mode
    orchestrator.ts     # Autonomous cycle loop
    orchestrator-cli.ts # CLI entry point: npx tsx src/orchestrator-cli.ts
    realtime.ts         # WebSocket server for assist mode
    realtime-cli.ts     # CLI entry point: npx tsx src/realtime-cli.ts
    spawn.ts            # Fork-based worker manager with IPC heartbeats
    config.ts           # JSON config loader with Zod validation
    state.ts            # SQLite state manager (same schema as existing DB)
    safety.ts           # Pre-execution hooks (branch, force push, concurrency, .env)
    context.ts          # Context window management (token estimation, compaction)
    skills.ts           # Skill file loader with helper inlining
    types.ts            # Shared type definitions
    tools/
      index.ts          # Tool registry and dispatcher
      file.ts           # file_read, file_write, file_edit
      search.ts         # glob_search, grep_search
      bash.ts           # bash_exec with timeout
      git.ts            # Git operations with branch safety
      github.ts         # GitHub CLI wrappers
      linear.ts         # Direct Linear GraphQL API client
    router/
      router.ts         # 4-tier model selection cascade
      client.ts         # OpenAI SDK wrapper for LiteLLM proxy
      feedback.ts       # Run outcome tracking
      weights.ts        # Composite score calculation
    phases/
      types.ts          # SpawnRequest, PhaseResult interfaces
      ops.ts            # Ops phase (stub — reaps stale workers)
      triage.ts         # Triage phase (stub)
      pr.ts             # PR phase (stub)
```

## Harness compilation

Skills are the portable source of truth. Harnesses compile them into runtime-specific formats.

```
harness/
  compile.ts          # CLI: npx tsx harness/compile.ts --target claude-code|codex|all
  claude-code.ts      # Generates .claude/commands/*.md with checkpoint SQL inlined
  codex.ts            # Generates harness/output/codex/*.md with SQL stripped
  types.ts            # Skill metadata registry
  README.md           # Documentation
  output/
    codex/            # Generated Codex task definitions
```

Usage:
```bash
npx tsx harness/compile.ts --target all          # Compile all skills to all targets
npx tsx harness/compile.ts --target claude-code   # Just Claude Code commands
npx tsx harness/compile.ts --target codex         # Just Codex tasks
npx tsx harness/compile.ts --skill execute        # Just one skill
```

## Worker types

| Role | Skill | Spawned by | Default model | What it does |
|------|-------|-----------|---------------|--------------|
| Executor | `execute` | phase-triage | Opus (explore/plan), GPT-5 (implement/test) | Explore → plan → implement → test → commit → push → draft PR |
| Explorer | `explore` | phase-triage | Opus | Investigate codebase → post findings to Linear (complexity ≥ 3, no implementation) |
| Docs | `docs` | phase-pr | Sonnet | Read executor knowledge → update CLAUDE.md/READMEs → docs PR |
| Reviewer | `review` | phase-pr | Opus | Sync worktree → address review comments → commit → push |
| CI fixer | `ci_fix` | phase-pr | Sonnet | Investigate CI failure → fix → test → push |
| Auditor | `audit` | phase-pr | Gemini | Classify size → architectural review → risk assess → label/approve |

## Repo mappings

Repos are configured in `config.json` under the `repos` key. Each entry maps a repo name to its local path.

## Worktree conventions

- Root: `<worktree_root from config>`
- Implementation branches: `<branch_prefix from config>/gm-{ticket_number}-{slug}`
- Documentation branches: `<branch_prefix from config>/docs-{identifier}`
- Always branch from `origin/main` after `git fetch origin main`
- Always unset upstream tracking after worktree creation
- Cleanup: `scripts/cleanup-worktrees.sh [--dry-run]`

## Commands (Claude Code mode)

All `.claude/commands/marvin-*.md` files are **generated** from `skills/*.md` via `harness/compile.ts`. Do not edit directly.

| Command | Skill source | Purpose |
|---------|-------------|---------|
| `/marvin-cycle` | `skills/orchestrator.md` | Orchestrator loop |
| `/marvin-phase-ops` | `skills/phase-ops.md` | Ops phase |
| `/marvin-phase-triage` | `skills/phase-triage.md` | Triage phase |
| `/marvin-phase-pr` | `skills/phase-pr.md` | PR phase |
| `/marvin-execute` | `skills/execute.md` | Executor worker |
| `/marvin-explore` | `skills/explore.md` | Explorer worker |
| `/marvin-docs` | `skills/docs.md` | Docs worker |
| `/marvin-review` | `skills/review.md` | Review worker |
| `/marvin-ci-fix` | `skills/ci-fix.md` | CI-fix worker |
| `/marvin-audit` | `skills/audit.md` | Audit worker |
| `/marvin-reassign` | `skills/reassign.md` | Reassignment |
| `/marvin-digest` | `skills/digest.md` | Digest generation |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/run-marvin.sh` | Launch orchestrator with auto-restart loop |
| `scripts/stop-marvin.sh` | Kill wrapper loop, orchestrator, workers, and dashboard |
| `scripts/setup.sh` | First-time DB initialization via migrations |
| `scripts/migrate.sh` | Apply pending schema migrations |
| `scripts/backup-db.sh` | Safe SQLite backup with 7-day retention |
| `scripts/cleanup-worktrees.sh` | Remove worktrees for merged/closed PRs |
| `scripts/dashboard.py` | Local web UI on port 7777 |
| `scripts/run-cycle.sh` | Run a single cycle (for testing) |
| `scripts/run-digest.sh` | Generate a digest |
| `scripts/pr-age-labels.sh` | Apply age labels (fresh/ripe/overripe/rotting) to open PRs |

## Triage prompt

The triage prompt template is at `prompts/triage.md`. It produces a JSON object with:
- `complexity` (1-5)
- `target_repo`
- `affected_paths[]`
- `route` (execute/reassign/defer)
- `route_reason`
- `confidence` (0-1)
- `risks[]`
- `implementation_hint`
- `recommended_assignee`

### Routing rules

| Route | When | Action |
|-------|------|--------|
| `execute` | No specific CODEOWNERS entry, complexity ≤ `complexity_threshold` (default 2) | Assign to configured assignee, setup worktree, spawn executor |
| `explore` | No specific CODEOWNERS entry, complexity > `complexity_threshold` | Assign to configured assignee, setup worktree, spawn explorer |
| `reassign` | Specific CODEOWNERS entry exists | Reassign in Linear to that person |
| `defer` | Can't determine repo/area | Post clarifying questions |

## Subsystem details

Domain logic lives in the skill files (`skills/*.md`). Shared patterns live in helpers (`skills/helpers/*.md`). Refer to:
- `skills/phase-triage.md` for triage, defer, and routing details
- `skills/phase-pr.md` for PR polling, CI-fix, audit, review, undraft, and docs details
- `skills/phase-ops.md` for reaping thresholds, stats recording, and digest generation

## Running Marvin

### v2 runtime (standalone TypeScript)

```bash
cd runtime && npm install

# Autonomous mode (overnight)
npx tsx src/orchestrator-cli.ts

# Assist mode (human-in-the-loop, port 7780)
npx tsx src/realtime-cli.ts

# Single skill execution
SKILL=execute ARGS='{"linear_id":"...","identifier":"GM-1234",...}' npx tsx src/agent.ts

# Dashboard (port 7777)
python3 scripts/dashboard.py
```

### v1 runtime (Claude Code, still works)

```bash
# Recompile skills to Claude Code commands first
npx tsx harness/compile.ts --target claude-code

# Then run via Claude Code
claude --dangerously-skip-permissions \
  --plugin-dir "$PLUGINS_DIR/linear-mcp/" \
  --plugin-dir "$PLUGINS_DIR/local-memory-mcp/" \
  -p "Run /marvin-cycle"
```

## Remote deployment (EKS + Istio)

Marvin runs on an EKS cluster with Istio ingress. oauth2-proxy runs as a sidecar for AAD auth.

```
Internet → Custom domain (CNAME → Istio IngressGateway LB)
  → Istio Gateway (TLS termination)
    → VirtualService → marvin Service (port 80)
      → Pod:
        ├─ oauth2-proxy sidecar (port 8080, AAD auth + security group gate)
        │    → dashboard.py (port 7777)
        ├─ marvin container (orchestrator + dashboard)
        │    → /data/state (EBS gp3 PVC) — SQLite DB, logs, backups
        │    → /data/repos (EBS gp3 PVC) — cloned repos + worktrees
        └─ istio-proxy sidecar (auto-injected)
```

### Deploy files

| File | Purpose |
|------|---------|
| `deploy/Dockerfile` | Ubuntu 22.04 with claude CLI, gh CLI, sqlite3, uv |
| `deploy/entrypoint.sh` | Init volumes → migrate DB → clone repos → start dashboard → exec run-marvin.sh |
| `deploy/k8s/namespace.yaml` | `marvin` namespace with Istio injection |
| `deploy/k8s/pvc.yaml` | Two EBS gp3 PVCs: `marvin-state` (5Gi) and `marvin-repos` (50Gi) |
| `deploy/k8s/configmap.yaml` | oauth2-proxy config (AAD OIDC, security group gate) |
| `deploy/k8s/deployment.yaml` | Single-replica Deployment with marvin + oauth2-proxy sidecar |
| `deploy/k8s/service.yaml` | ClusterIP service routing to oauth2-proxy port |
| `deploy/k8s/istio.yaml` | Gateway (TLS) + VirtualService for custom domain |
| `deploy/k8s/secret.yaml` | Template for `marvin-secrets` (create manually via kubectl) |
| `deploy/k8s/kustomization.yaml` | Kustomize root for `kubectl apply -k` |
| `deploy/k8s/deploy.sh` | Build/push/apply helper script |
| `config/remote.json` | Config with container paths (`/data/repos/...`, `/data/state/...`) |

### Environment variables

| Variable | Purpose |
|----------|---------|
| `MARVIN_REMOTE` | Set to `"1"` — dashboard binds `0.0.0.0`, skip local dashboard launch in run-marvin.sh |
| `MARVIN_CONFIG` | Path to config JSON (falls back to `config/default.json`) |
| `MARVIN_PLUGINS_DIR` | Path to MCP plugins directory (overrides config) |
| `LITELLM_BASE_URL` / `ANTHROPIC_BASE_URL` | LiteLLM proxy URL (for v2 runtime) |
| `LITELLM_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | LiteLLM proxy auth token (for v2 runtime) |
| `LINEAR_API_KEY` | Linear API key (for v2 runtime direct API calls) |
| `REALTIME_PORT` | WebSocket server port (default 7780) |

### First-time deploy

```bash
# 1. Copy MCP plugins
cp -r /path/to/your/plugins/linear-mcp deploy/plugins/
cp -r /path/to/your/plugins/local-memory-mcp deploy/plugins/

# 2. Fill in placeholders in deploy/k8s/configmap.yaml:
#    TENANT_ID, SECURITY_GROUP_ID, CUSTOM_DOMAIN
# And in deploy/k8s/istio.yaml:
#    CUSTOM_DOMAIN, TLS credential name

# 3. Create the secret
kubectl create ns marvin
kubectl -n marvin create secret generic marvin-secrets \
  --from-literal=ANTHROPIC_API_KEY='...' \
  --from-literal=GH_TOKEN='...' \
  --from-literal=LINEAR_API_KEY='...' \
  --from-literal=OAUTH2_PROXY_CLIENT_ID='...' \
  --from-literal=OAUTH2_PROXY_CLIENT_SECRET='...' \
  --from-literal=OAUTH2_PROXY_COOKIE_SECRET="$(python3 -c 'import os,base64;print(base64.urlsafe_b64encode(os.urandom(32)).decode())')"

# 4. Build, push, and apply
export MARVIN_REGISTRY=your-ecr-repo.dkr.ecr.us-west-2.amazonaws.com
./deploy/k8s/deploy.sh
```

### Subsequent deploys

```bash
./deploy/k8s/deploy.sh                # Full: build + push + apply
./deploy/k8s/deploy.sh --apply-only   # Just apply manifest changes
./deploy/k8s/deploy.sh --restart      # Restart pod (pick up new image)
./deploy/k8s/deploy.sh --logs         # Tail logs
./deploy/k8s/deploy.sh --ssh          # Exec into container
```

---

# Deep Thought — Autonomous Observability & Codebase Analysis System

Deep Thought is a separate orchestrator that lives in the same repo as Marvin. It continuously scans Datadog alerts, APM traces, log patterns, and codebases to proactively identify issues and create Linear tickets for Marvin to execute.

**Key difference from Marvin**: Deep Thought **creates** tickets in Linear (Marvin only consumes them). Deep Thought is **read-only** on codebases (Marvin modifies them). They form a proactive-reactive pipeline: Deep Thought finds problems → creates tickets → Marvin picks them up and fixes them.

## Architecture

```
run-deep-thought.sh (restart loop)
  └─ claude (orchestrator / team lead) — /dt-cycle
       │
       ├─ Phase 1: /dt-phase-ops (Task agent, sequential)
       │    ├─ Reap stale scanner teammates
       │    ├─ Reconcile resolved findings (check closed tickets)
       │    ├─ Record cycle stats
       │    └─ Trim old data
       │
       ├─ Phase 2: /dt-phase-alerts (Task agent, sequential)
       │    ├─ Poll Datadog monitors (triggered/warn states)
       │    ├─ Poll recent alert events
       │    ├─ Assess actionability & deduplicate
       │    └─ Create Linear tickets for actionable alerts
       │
       ├─ Phase 3: /dt-phase-telemetry (Task agent, sequential)
       │    ├─ Query APM: slow traces, error rate spikes, P99 regressions
       │    ├─ Query logs: recurring error patterns, volume anomalies
       │    ├─ Correlate findings across signals
       │    └─ Create Linear tickets for actionable findings
       │
       ├─ Phase 4: /dt-phase-codebase (Task agent, sequential)
       │    ├─ Spawn scanner teammates (background)
       │    │    ├─ /dt-scan-todos — TODO/FIXME/HACK scanner
       │    │    ├─ /dt-scan-deps — Dependency staleness checker
       │    │    └─ /dt-scan-patterns — Anti-pattern detector
       │    ├─ Collect completed scanner results
       │    └─ Create Linear tickets for actionable findings
       │
       ├─ Self-restart check (exit after 4 cycles, ~24 hours)
       └─ Sleep (cycle_interval_seconds, default 21600 = 6 hours)
```

## Safety invariants

- **Read-only codebase access** — never modifies code, only reads
- **Deduplication** — findings are deduped by hash before ticket creation
- **Rate limiting** — max 5 tickets per cycle (configurable)
- **Confidence threshold** — only creates tickets for findings with confidence ≥ 0.7
- **Cooldown** — won't re-create tickets for the same finding within 7 days
- **Labeling** — all created tickets get `🧠 Deep Thought` label
- All tickets created on the configured team, assigned to the configured assignee

## State management

- Separate SQLite database at `~/.deep-thought/state/deep-thought.db`
- Schema managed via numbered migrations in `schema/dt-migrations/`
- Run `scripts/dt-migrate.sh` to apply migrations
- All timestamps use `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` — never `datetime('now')`

### Database tables

| Table | Purpose |
|-------|---------|
| `findings` | Core finding tracking — source, type, severity, confidence, dedup hash, ticket link, cooldown |
| `scan_runs` | Per-cycle stats per phase (alerts checked, traces checked, findings created, tickets created) |
| `heartbeat` | Singleton row: orchestrator liveness (cycle number, current step, last beat) |
| `cycle_events` | Per-cycle event log for dashboard activity |
| `scanner_runs` | Codebase scanner attempt tracking (type, repo, status, results file) |
| `schema_version` | Tracks applied migrations |
| (last_phase columns) | `002_scanner_progress.sql` | Adds `last_phase TEXT` and `last_phase_at TEXT` to scanner_runs for liveness tracking |

### Configuration

Config in `config/deep-thought.json` (see `config/deep-thought.example.json` for a template):

```json
{
  "team": "YourTeam",
  "assignee": "your-linear-username",
  "repos": {
    "your-infra-repo": "/path/to/your-infra-repo",
    "your-main-repo": "/path/to/your-main-repo"
  },
  "state_db": "~/.deep-thought/state/deep-thought.db",
  "log_dir": "~/.deep-thought/logs",
  "backup_dir": "~/.deep-thought/backups",
  "linear_label": "🧠 Deep Thought",
  "github_org": "your-github-org",
  "github_user": "your-github-username",
  "linear_workspace_slug": "your-workspace",
  "plugins_dir": "/path/to/mcp-plugins",
  "cycle_interval_seconds": 21600,
  "self_restart_after_cycles": 4,
  "limits": {
    "max_tickets_per_cycle": 5,
    "confidence_threshold": 0.7,
    "finding_cooldown_days": 7,
    "stale_scanner_minutes": 60,
    "alert_lookback_hours": 12,
    "trace_lookback_hours": 12,
    "log_lookback_hours": 12,
    "error_rate_spike_threshold": 2.0,
    "p99_regression_threshold_ms": 500,
    "dependency_staleness_days": 180
  },
  "datadog": {
    "site": "datadoghq.com",
    "monitor_tags": ["team:your-team"],
    "service_filter": "your-service-*",
    "env": "production"
  }
}
```

### Dashboard

Web UI at `http://localhost:7778` (run `scripts/dt-dashboard.py`):
- **Health banner**: Green (pulsing) / yellow / red based on orchestrator heartbeat age
- **Tabs**: Findings, Alerts, Telemetry, Codebase, Runs, Log
- Auto-refreshes every 60s
- `/api/heartbeat`, `/api/findings`, `/api/runs`, `/api/activity`, `/api/scanners` endpoints

## Deep Thought commands

| Command | Purpose |
|---------|---------|
| `/dt-cycle` | Orchestrator main loop: dispatch phases → self-restart after 4 cycles |
| `/dt-phase-ops` | Ops phase: reap stale scanners → reconcile resolved → stats → trim |
| `/dt-phase-alerts` | Alerts phase: poll Datadog monitors → assess → create tickets |
| `/dt-phase-telemetry` | Telemetry phase: APM traces → error rates → log patterns → create tickets |
| `/dt-phase-codebase` | Codebase phase: spawn scanners → collect results → create tickets |
| `/dt-scan-todos` | Scanner worker: find TODO/FIXME/HACK comments |
| `/dt-scan-deps` | Scanner worker: find stale dependencies |
| `/dt-scan-patterns` | Scanner worker: find anti-patterns and code quality issues |

## Deep Thought scripts

| Script | Purpose |
|--------|---------|
| `scripts/run-deep-thought.sh` | Launch orchestrator with auto-restart loop |
| `scripts/stop-deep-thought.sh` | Kill all Deep Thought processes |
| `scripts/dt-setup.sh` | First-time DB initialization |
| `scripts/dt-migrate.sh` | Apply pending schema migrations |
| `scripts/dt-dashboard.py` | Dashboard on port 7778 |

## Deep Thought environment variables

| Variable | Purpose |
|----------|---------|
| `DEEP_THOUGHT_REMOTE` | Set to `"1"` — dashboard binds `0.0.0.0` |
| `DEEP_THOUGHT_CONFIG` | Path to config JSON (falls back to `config/deep-thought.json`) |
| `DEEP_THOUGHT_PLUGINS_DIR` | Path to MCP plugins directory |

## MCP plugins (Deep Thought)

Deep Thought requires these MCP plugins:
- `linear-mcp` — for creating and querying Linear tickets
- `local-memory-mcp` — for cross-session memory
- `datadog-mcp` — for querying Datadog monitors, APM, logs (requires `DD_API_KEY` and `DD_APP_KEY` env vars)

## Assessment prompts

- `prompts/dt-alert-assess.md` — alert actionability assessment template
- `prompts/dt-telemetry-assess.md` — telemetry finding assessment template
