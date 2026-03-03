<img width="181" height="253" alt="marvin-solo" src="https://github.com/user-attachments/assets/548ab603-0590-4ed2-8562-3f297ec33748" />

# Marvin & Deep Thought

Two autonomous agent systems built on [Claude Code](https://claude.ai/claude-code) that form a proactive-reactive pipeline for your team's infrastructure.

**Marvin** watches Linear for tickets, triages them, implements changes via agent teammates, creates draft PRs, monitors review comments, auto-fixes CI failures, and audits all open PRs — all without human intervention until merge time. High-complexity tickets (≥3/5) get explore-only treatment: Marvin investigates and posts findings for human review.

**Deep Thought** continuously scans Datadog alerts, APM traces, log patterns, and codebases to proactively identify issues and create Linear tickets for Marvin to execute.

```
Deep Thought finds problems → creates tickets → Marvin picks them up and fixes them
```

---

## Marvin — Ticket execution

### How it works

```
run-marvin.sh (restart loop)
  └─ claude (orchestrator / team lead) — /marvin-cycle
       │
       ├─ Phase 1: /marvin-phase-ops
       │    ├─ Trim old data
       │    ├─ Reap stale teammates
       │    ├─ Record cycle stats
       │    └─ Hourly digest
       │
       ├─ Phase 2: /marvin-phase-triage
       │    ├─ Poll Linear (assigned to me + Platform label)
       │    ├─ Triage new tickets (one at a time: triage → route → spawn)
       │    ├─ Route (execute/explore/reassign/defer)
       │    └─ Poll deferred tickets for updates
       │
       ├─ Phase 3: /marvin-phase-pr
       │    ├─ Update banana age labels on PRs
       │    ├─ Poll open PRs, detect CI failures → spawn ci-fix teammates
       │    ├─ Detect audit candidates → spawn audit teammates
       │    ├─ Poll review comments → spawn review teammates
       │    ├─ Undraft ready PRs
       │    └─ Spawn docs teammates
       │
       ├─ Self-restart after 48 cycles (~24h)
       └─ Sleep (30 min between cycles)
```

### Ticket lifecycle

```
Linear (unstarted)
  → Triage (route: execute / explore / reassign / defer)
  → Execute (complexity ≤ 2: explore → plan → implement → test → commit → draft PR)
  → Explore (complexity ≥ 3: investigate → post findings → await human review)
  → Done
  → Review comments detected → review teammate addresses them → done
  → CI failure → ci-fix teammate investigates and pushes fix → done
  → PR merged/closed
```

### Routing

Tickets are routed based on CODEOWNERS and complexity:

| Route | When | Action |
|-------|------|--------|
| **Execute** | No specific code owner, complexity ≤ 2 | Agent implements it end-to-end |
| **Explore** | No specific code owner, complexity ≥ 3 | Agent investigates, posts findings for human review |
| **Reassign** | Specific CODEOWNERS entry | Reassign to that person |
| **Defer** | Can't determine repo/area | Post clarifying questions, follow up |

### Worker types

| Role | Command | What it does |
|------|---------|--------------|
| Executor | `/marvin-execute` | Explore → plan → implement → test → commit → push → draft PR |
| Explorer | `/marvin-explore` | Investigate codebase → post findings to Linear (no code changes) |
| Docs | `/marvin-docs` | Read executor knowledge → update `docs/` → docs PR |
| Reviewer | `/marvin-review` | Sync worktree → address review comments → commit → push |
| CI fixer | `/marvin-ci-fix` | Investigate CI failure → fix → test → push |
| Auditor | `/marvin-audit` | Classify size → architectural review → risk assess → label/approve |

### PR labels

Marvin applies labels to all PRs it manages:

- **`marvin-reviewed`** (blue) — applied after audit completes
- **`age:fresh`** (green) — PR opened < 1 day ago
- **`age:ripe`** (yellow) — PR open 1–3 days
- **`age:overripe`** (orange) — PR open 3–7 days
- **`age:rotting`** (red) — PR open > 7 days
- **`risk:low/medium/high`** — audit risk assessment
- **`size:small/medium/large/jumbo`** — PR size classification

### Deferred ticket follow-up

When Marvin can't determine which repo or area a ticket affects, it defers the ticket — posting clarifying questions, monitoring for responses, and re-triaging when new info arrives. Maximum 3 follow-up comments, minimum 24h between them.

---

## Deep Thought — Observability & codebase analysis

### How it works

```
run-deep-thought.sh (restart loop)
  └─ claude (orchestrator / team lead) — /dt-cycle
       │
       ├─ Phase 1: /dt-phase-ops
       │    ├─ Reap stale scanner teammates
       │    ├─ Reconcile resolved findings (check closed tickets)
       │    ├─ Record cycle stats
       │    └─ Trim old data
       │
       ├─ Phase 2: /dt-phase-alerts
       │    ├─ Poll Datadog monitors (triggered/warn states)
       │    ├─ Poll recent alert events
       │    ├─ Assess actionability & deduplicate
       │    └─ Create Linear tickets for actionable alerts
       │
       ├─ Phase 3: /dt-phase-telemetry
       │    ├─ Query APM: slow traces, error rate spikes, P99 regressions
       │    ├─ Query logs: recurring error patterns, volume anomalies
       │    ├─ Correlate findings across signals
       │    └─ Create Linear tickets for actionable findings
       │
       ├─ Phase 4: /dt-phase-codebase
       │    ├─ Spawn scanner teammates (background)
       │    │    ├─ /dt-scan-todos — TODO/FIXME/HACK scanner
       │    │    ├─ /dt-scan-deps — Dependency staleness checker
       │    │    └─ /dt-scan-patterns — Anti-pattern detector
       │    ├─ Collect completed scanner results
       │    └─ Create Linear tickets for actionable findings
       │
       ├─ Self-restart after 4 cycles (~24h)
       └─ Sleep (6 hours between cycles)
```

### Safety

- **Read-only codebase access** — never modifies code
- **Deduplication** — findings are deduped by hash before ticket creation
- **Rate limiting** — max 5 tickets per cycle
- **Confidence threshold** — only creates tickets for findings with confidence ≥ 0.7
- **Cooldown** — won't re-create tickets for the same finding within 7 days
- **Labeling** — all created tickets get `🧠 Deep Thought` label

---

## Quick start

```bash
# 1. Create your config from the example template
cp config/example.json config/default.json
# Edit config/default.json with your team, repos, paths, etc.

# 2. (Optional) Create Deep Thought config
cp config/deep-thought.example.json config/deep-thought.json
# Edit config/deep-thought.json with your Datadog and team settings

# 3. Initialize databases
./scripts/setup.sh          # Marvin
./scripts/dt-setup.sh       # Deep Thought

# 4. Start
./scripts/run-marvin.sh     # Marvin (auto-restart loop)
./scripts/run-deep-thought.sh  # Deep Thought (auto-restart loop)
```

## Setup

```bash
# Install dependencies and initialize Marvin DB
./scripts/setup.sh

# Initialize Deep Thought DB
./scripts/dt-setup.sh
```

### Prerequisites

- [Claude Code](https://claude.ai/claude-code) CLI
- `gh` CLI (authenticated)
- `sqlite3`
- Linear MCP server (`linear-mcp`)
- Local memory MCP server (`local-memory-mcp`)
- Datadog MCP server (`datadog-mcp`) — Deep Thought only
- LiteLLM proxy (optional, for cost management)

### Environment

LiteLLM proxy vars (if using a proxy):
```bash
export ANTHROPIC_BASE_URL="..."
export ANTHROPIC_AUTH_TOKEN="..."
export ANTHROPIC_SMALL_FAST_MODEL="..."
```

Deep Thought additionally requires:
```bash
export DD_API_KEY="..."
export DD_APP_KEY="..."
```

## Usage

### Marvin

```bash
./scripts/run-marvin.sh          # Start (auto-restart loop, 30-min cycles)
./scripts/stop-marvin.sh         # Stop everything
./scripts/run-digest.sh          # Print status digest
```

Dashboard at `http://localhost:7777` — tabs: Tickets, Teammates, Work, Digests, Log.

### Deep Thought

```bash
./scripts/run-deep-thought.sh    # Start (auto-restart loop, 6-hour cycles)
./scripts/stop-deep-thought.sh   # Stop everything
```

Dashboard at `http://localhost:7778` — tabs: Findings, Alerts, Telemetry, Codebase, Runs, Log.

## Commands

### Marvin

| Command | Purpose |
|---------|---------|
| `/marvin-cycle` | Thin orchestrator loop: dispatch phases → self-restart |
| `/marvin-phase-ops` | Ops phase: reap stale teammates → stats → digest |
| `/marvin-phase-triage` | Triage phase: poll Linear → triage → route → check deferred |
| `/marvin-phase-pr` | PR phase: banana labels → CI-fix → audit → reviews → undraft → docs |
| `/marvin-execute` | Executor worker: explore → plan → implement → PR |
| `/marvin-explore` | Explorer worker: investigate → post findings (no implementation) |
| `/marvin-docs` | Docs worker: read executor knowledge → update docs/ → PR |
| `/marvin-review` | Review worker: address PR feedback → commit → push |
| `/marvin-ci-fix` | CI-fix worker: investigate failure → fix → test → push |
| `/marvin-audit` | Audit worker: classify → review → risk assess → label/approve |
| `/marvin-reassign` | Reassign a ticket based on CODEOWNERS |
| `/marvin-digest` | Status digest (also runs automatically each cycle) |

### Deep Thought

| Command | Purpose |
|---------|---------|
| `/dt-cycle` | Orchestrator loop: dispatch phases → self-restart after 4 cycles |
| `/dt-phase-ops` | Ops: reap stale scanners → reconcile resolved → stats → trim |
| `/dt-phase-alerts` | Alerts: poll Datadog monitors → assess → create tickets |
| `/dt-phase-telemetry` | Telemetry: APM traces → error rates → log patterns → create tickets |
| `/dt-phase-codebase` | Codebase: spawn scanners → collect results → create tickets |
| `/dt-scan-todos` | Scanner: find TODO/FIXME/HACK comments |
| `/dt-scan-deps` | Scanner: find stale dependencies |
| `/dt-scan-patterns` | Scanner: find anti-patterns and code quality issues |

## State

### Marvin — `~/.marvin/state/marvin.db`

| Table | Purpose |
|-------|---------|
| `tickets` | Ticket triage, execution status, PR info, review status, defer tracking |
| `runs` | Per-cycle stats (tickets found, triaged, executed, failed) |
| `digests` | Digest history |
| `pull_requests` | Open PRs with CI, review, staging, merge-readiness, CI fix + audit tracking |
| `review_comments` | PR review comments from GitHub |
| `review_runs` | Review processing sessions |
| `ci_fix_runs` | CI fix attempts per PR |
| `audit_runs` | PR audit attempts |
| `heartbeat` | Orchestrator liveness (cycle number, current step, last beat) |
| `cycle_events` | Per-cycle event log for dashboard |
| `reassess_requests` | Dashboard → orchestrator queue for manual re-triage |
| `doc_runs` | Documentation follow-up PR tracking |
| `schema_version` | Applied schema migrations |

### Deep Thought — `~/.deep-thought/state/deep-thought.db`

| Table | Purpose |
|-------|---------|
| `findings` | Finding tracking — source, type, severity, confidence, dedup hash, ticket link |
| `scan_runs` | Per-cycle stats per phase |
| `heartbeat` | Orchestrator liveness |
| `cycle_events` | Per-cycle event log |
| `scanner_runs` | Codebase scanner attempt tracking |
| `schema_version` | Applied schema migrations |

## Safety

Both systems are designed to be safe by default:

**Marvin:**
- Never creates Linear tickets — only updates existing ones
- Never merges PRs — always creates as draft
- Never deploys anything
- Never modifies main — always uses git worktrees from `origin/main`
- Never force-pushes
- Auto-approval only for risk:low PRs with passing CI
- Complexity ≥ 3 tickets get explore-only (no implementation)

**Deep Thought:**
- Read-only codebase access — never modifies code
- Deduplication prevents duplicate ticket creation
- Rate-limited to 5 tickets per cycle
- 7-day cooldown on re-creating the same finding

## Deployment

Supports local and remote (EKS + Istio) deployment. See `deploy/` for:
- `Dockerfile` — Ubuntu 22.04 with claude CLI, gh, sqlite3, uv
- `deploy/k8s/` — Kubernetes manifests (namespace, deployment, PVCs, service, Istio gateway, oauth2-proxy sidecar for AAD auth)
- `deploy/k8s/deploy.sh` — build/push/apply helper
- `config/remote.json` — container paths for remote deployment

Environment variables for remote: `MARVIN_REMOTE`, `MARVIN_CONFIG`, `MARVIN_PLUGINS_DIR`.

## Project structure

```
.claude/
  CLAUDE.md                        # Project instructions
  commands/
    marvin-cycle.md                # Marvin orchestrator loop
    marvin-phase-ops.md            # Ops phase
    marvin-phase-triage.md         # Triage phase
    marvin-phase-pr.md             # PR phase
    marvin-execute.md              # Executor worker
    marvin-explore.md              # Explorer worker (complexity ≥ 3)
    marvin-docs.md                 # Documentation worker
    marvin-review.md               # Review worker
    marvin-ci-fix.md               # CI-fix worker
    marvin-audit.md                # PR audit worker
    marvin-reassign.md             # Reassignment
    marvin-digest.md               # Digest generation
    dt-cycle.md                    # Deep Thought orchestrator loop
    dt-phase-ops.md                # DT ops phase
    dt-phase-alerts.md             # DT alerts phase
    dt-phase-telemetry.md          # DT telemetry phase
    dt-phase-codebase.md           # DT codebase phase
    dt-scan-todos.md               # TODO/FIXME scanner
    dt-scan-deps.md                # Dependency staleness scanner
    dt-scan-patterns.md            # Anti-pattern scanner
config/
  default.json                     # Marvin config (create from example.json)
  example.json                     # Marvin config template
  remote.json                      # Marvin config (container paths)
  remote.example.json              # Remote config template
  deep-thought.json                # Deep Thought config (create from example)
  deep-thought.example.json        # Deep Thought config template
prompts/
  triage.md                        # Marvin triage prompt
  dt-alert-assess.md               # DT alert assessment prompt
  dt-telemetry-assess.md           # DT telemetry assessment prompt
schema/
  migrations/                      # Marvin schema migrations
    001_initial.sql ... 011_spawn_queue_ticket.sql
  dt-migrations/                   # Deep Thought schema migrations
    001_initial.sql
deploy/
  Dockerfile                       # Container image
  entrypoint.sh                    # Container entrypoint
  k8s/                             # Kubernetes manifests
    namespace.yaml, deployment.yaml, service.yaml,
    pvc.yaml, configmap.yaml, istio.yaml,
    kustomization.yaml, deploy.sh, secret.yaml
  plugins/                         # MCP plugins (copy before build)
scripts/
  run-marvin.sh                    # Marvin start (auto-restart loop)
  stop-marvin.sh                   # Marvin stop
  run-cycle.sh                     # Run single Marvin cycle
  run-digest.sh                    # Generate Marvin digest
  setup.sh                         # Marvin first-time setup
  migrate.sh                       # Marvin schema migrations
  backup-db.sh                     # Safe SQLite backup
  cleanup-worktrees.sh             # Remove worktrees for merged/closed PRs
  dashboard.py                     # Marvin dashboard (port 7777)
  run-deep-thought.sh              # Deep Thought start
  stop-deep-thought.sh             # Deep Thought stop
  dt-setup.sh                      # Deep Thought first-time setup
  dt-migrate.sh                    # Deep Thought schema migrations
  dt-dashboard.py                  # Deep Thought dashboard (port 7778)
```
