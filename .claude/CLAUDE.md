# Marvin — Autonomous Linear Ticket Triage & Execution System

> **NEVER commit or push directly to `main` on repos Marvin works on** (configured in `config.json`). All changes must go through a worktree branch (`<branch_prefix from config>/*`) and a draft PR. The marvin repo itself is fine to commit to main.

Marvin watches Linear for tickets on the configured team — both tickets assigned to the configured assignee and tickets tagged with the configured label (regardless of assignee). It polls triage, backlog, and unstarted states. For all tickets without a specific CODEOWNERS entry, Marvin assigns to the configured assignee and executes via an agent teammate. For tickets with a specific CODEOWNERS entry, Marvin reassigns to the identified owner. Ambiguous tickets where the repo/area can't be determined are deferred.

## Architecture

Marvin is a **phase-based orchestrator with self-restart**. The thin EM loop (`/marvin-cycle`) dispatches work to phase agents each cycle, then sleeps. After a configured number of cycles (default 24, ~24 hours), the EM exits cleanly and the wrapper script (`run-marvin.sh`) restarts it with a fresh context window.

```
run-marvin.sh (restart loop)
  └─ claude (orchestrator / team lead) — /marvin-cycle
       │
       ├─ Phase 1: /marvin-phase-ops (Task agent, sequential)
       │    ├─ Trim old data (cycle_events, digests, spawn_queue)
       │    ├─ Reap stale teammates (all 5 types)
       │    ├─ Record cycle stats
       │    └─ Hourly digest
       │
       ├─ Phase 2: /marvin-phase-triage (Task agent, sequential)
       │    ├─ Process dashboard reassess requests
       │    ├─ Poll Linear (assigned to me + Platform label)
       │    ├─ Filter & triage new tickets
       │    ├─ Route (execute/explore/reassign/defer)
       │    │    ├─ execute → assign to configured assignee, setup worktree, queue executor in spawn_queue
       │    │    ├─ explore → assign to configured assignee, setup worktree, queue explorer in spawn_queue
       │    │    ├─ reassign → assign to CODEOWNERS person
       │    │    └─ defer → post clarifying questions
       │    └─ Poll deferred tickets for new info
       │
       ├─ Drain spawn_queue → spawn executors/explorers (background)
       │
       ├─ Phase 3: /marvin-phase-pr (Task agent, sequential)
       │    ├─ Poll open PRs, upsert into DB (incl. merge status)
       │    ├─ Auto-rebase behind PRs (when CI passes + reviews addressed)
       │    ├─ Detect CI failures, queue CI-fix in spawn_queue
       │    ├─ Detect audit candidates, queue auditors in spawn_queue
       │    ├─ Poll review comments, queue reviewers in spawn_queue
       │    ├─ Undraft ready PRs (requires MERGEABLE)
       │    └─ Queue docs in spawn_queue
       │
       ├─ Drain spawn_queue → spawn CI-fixers/auditors/reviewers/docs (background)
       │
       ├─ Self-restart check (exit after N cycles)
       └─ Sleep (cycle_interval_seconds, default 1800)
```

### Phase execution model

Phases run as **short-lived Task agents** (not Skill invocations). Each phase loads its own command, does all work, **queues worker spawn requests in the `spawn_queue` DB table**, returns a short summary, and exits. After each phase completes, the orchestrator drains the spawn queue and spawns the workers itself. This is critical because phase agents are short-lived — if they spawned workers directly as background Task agents, the Claude runtime would kill those children when the phase exits. By having the long-lived orchestrator do the spawning, workers survive and run to completion.

The EM's context only grows by ~10 lines per phase per cycle, plus a few lines per queued worker spawn. At 48 cycles × 3 phases × ~10 lines = ~1440 lines before self-restart.

### Worker types

| Role | Command | Queued by | Spawned by | What it does |
|------|---------|-----------|-----------|--------------|
| Executor | `/marvin-execute` | phase-triage | orchestrator | Explore → plan → implement → test → commit → push → draft PR |
| Explorer | `/marvin-explore` | phase-triage | orchestrator | Investigate codebase → post findings to Linear (complexity ≥ 3, no implementation) |
| Docs | `/marvin-docs` | phase-pr | orchestrator | Read executor knowledge → update CLAUDE.md/READMEs → docs PR |
| Reviewer | `/marvin-review` | phase-pr | orchestrator | Sync worktree → address review comments → commit → push |
| CI fixer | `/marvin-ci-fix` | phase-pr | orchestrator | Investigate CI failure → fix → test → push |
| Auditor | `/marvin-audit` | phase-pr | orchestrator | Classify size → architectural review → risk assess → label/approve |

Workers are spawned via a **spawn queue** (`spawn_queue` table). Phase agents write spawn requests to the queue; the orchestrator drains the queue after each phase completes and spawns the workers. This ensures workers survive as long-lived background Task agents of the orchestrator, rather than being killed when the short-lived phase agent exits.

**Concurrency limit**: The orchestrator enforces a global maximum of **8 concurrent workers** across all types. Before draining the spawn queue, it counts running workers (executing/exploring tickets + running audit/review/ci_fix/doc runs). Only `8 - running` workers are spawned; the rest stay pending in the queue for the next cycle.

The orchestrator session launched via `run-marvin.sh` with only essential plugins (linear-mcp, local-memory-mcp) to keep teammate spawn commands short enough for tmux.

LiteLLM proxy env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_SMALL_FAST_MODEL`) are set in `~/.zshrc` so all shells and teammate processes inherit them.

## Safety invariants

- Never create tickets in Linear — only update existing ones (comments, state changes, assignments)
- Never merge PRs — always create as draft, undraft only when CI passes and review comments are addressed
- Auto-approval only for risk:low PRs with passing CI (via audit teammates)
- Never deploy anything
- Never modify main directly on target repos — always use worktrees branching from `origin/main`
- Always push with explicit refspec (`HEAD:refs/heads/<branch>`) — never rely on upstream tracking
- Always unset upstream tracking on new worktree branches to prevent accidental push to main
- Branch safety re-check before every commit/push phase in all teammate commands
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
| `pull_requests` | `001_initial.sql` | All open PRs (your assignee's + all repos configured for audit), CI/review/audit status, merge conflict detection, auto-rebase tracking (migration 007) |
| `review_comments` | `001_initial.sql` | Individual PR review comments with addressing status |
| `review_runs` | `001_initial.sql` | Review processing sessions |
| `ci_fix_runs` | `001_initial.sql` | CI fix attempt tracking per PR |
| `audit_runs` | `001_initial.sql` | Audit attempt tracking per PR, with `findings_json` (migration 002) |
| `schema_version` | `001_initial.sql` | Tracks applied migrations |
| `heartbeat` | `003_heartbeat.sql` | Singleton row: orchestrator liveness (cycle number, current step, last beat) |
| `cycle_events` | `003_heartbeat.sql` | Per-cycle event log for dashboard activity (capped at 500 rows) |
| `reassess_requests` | `004_reassess_queue.sql` | Dashboard → orchestrator queue for manual re-triage requests |
| `doc_runs` | `005_doc_runs.sql` | Documentation follow-up PR tracking |
| `spawn_queue` | `008_spawn_queue.sql` | Worker spawn requests: phases queue, orchestrator drains and spawns |
| (last_phase columns) | `009_worker_progress.sql` | Adds `last_phase TEXT` to tickets, audit_runs, ci_fix_runs, review_runs, doc_runs for timeout diagnostics |
| (last_phase_at columns) | `010_worker_heartbeat.sql` | Adds `last_phase_at TEXT` to tickets, audit_runs, ci_fix_runs, review_runs, doc_runs for liveness tracking |
| (ticket_linear_id column) | `011_spawn_queue_ticket.sql` | Adds `ticket_linear_id TEXT` to spawn_queue for status rollback on cancelled spawns |

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
  "digest_interval_minutes": 60,
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
    "poll_interval_idle_seconds": 900,
    "poll_interval_active_seconds": 120,
    "stale_executor_minutes": 120,
    "stale_reviewer_minutes": 60,
    "stale_ci_fix_minutes": 30,
    "stale_auditor_minutes": 30,
    "stale_docs_minutes": 30,
    "rebase_max_attempts": 3,
    "rebase_min_interval_minutes": 10
  }
}
```

### Dashboard

Web UI at `http://localhost:7777` (run `scripts/dashboard.py`):
- **Health banner**: Green (pulsing) / yellow / red based on orchestrator heartbeat age
- **Tabs**: Tickets, Teammates, Work, Digests, Log
- **Re-assess button** (↻) on each ticket to queue manual re-triage
- Auto-refreshes every 60s
- `/api/heartbeat`, `/api/tickets`, `/api/prs`, `/api/activity`, `/api/teammates` endpoints

## Repo mappings

Repos are configured in `config.json` under the `repos` key. Each entry maps a repo name to its local path. Example:

| Repo | Local path | Content |
|------|-----------|---------|
| `your-main-repo` | `<repos.your-main-repo from config>` | Your primary codebase |
| `your-infra-repo` | `<repos.your-infra-repo from config>` | Infrastructure as code |

## Worktree conventions

- Root: `<worktree_root from config>`
- Implementation branches: `<branch_prefix from config>/gm-{ticket_number}-{slug}`
- Documentation branches: `<branch_prefix from config>/docs-{identifier}`
- Always branch from `origin/main` after `git fetch origin main`
- Always unset upstream tracking after worktree creation
- Cleanup: `scripts/cleanup-worktrees.sh [--dry-run]`

## Commands

| Command | Purpose |
|---------|---------|
| `/marvin-cycle` | Thin orchestrator loop: dispatch phases → self-restart after N cycles |
| `/marvin-phase-ops` | Ops phase: reap stale teammates → record stats → digest → trim data |
| `/marvin-phase-triage` | Triage phase: reassess → poll Linear → triage → route → check deferred |
| `/marvin-phase-pr` | PR phase: poll PRs → merge status → auto-rebase → CI-fix → audit → reviews → undraft → docs |
| `/marvin-execute` | Executor worker: explore → plan → implement → test → PR → capture knowledge |
| `/marvin-explore` | Explore worker: investigate codebase → post findings to Linear (no implementation) |
| `/marvin-docs` | Docs worker: read executor knowledge → update CLAUDE.md/READMEs → docs PR |
| `/marvin-review` | Review worker: sync worktree → address comments → commit → push |
| `/marvin-ci-fix` | CI-fix worker: investigate failure → fix → test → push |
| `/marvin-audit` | Audit worker: classify size → architectural review → risk assess → label/approve |
| `/marvin-reassign` | Reassign a ticket based on CODEOWNERS |
| `/marvin-digest` | Executive summary: what got done, what's in flight, what needs attention |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/run-marvin.sh` | Launch orchestrator with auto-restart loop |
| `scripts/stop-marvin.sh` | Kill wrapper loop, orchestrator, teammates, and dashboard |
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
| `execute` | No specific CODEOWNERS entry, complexity ≤ `complexity_threshold` (default 2) | Assign to the configured assignee, setup worktree, queue executor (ticket stays `triaged` until orchestrator spawns) |
| `explore` | No specific CODEOWNERS entry, complexity > `complexity_threshold` | Assign to the configured assignee, setup worktree, queue explorer (ticket stays `triaged` until orchestrator spawns) |
| `reassign` | Specific CODEOWNERS entry exists | Reassign in Linear to that person |
| `defer` | Can't determine repo/area | Post clarifying questions |

## Key references

- Target repo conventions: `<repo_path from config>/.claude/CLAUDE.md`

## Subsystem details

Phase-specific logic (triage routing, PR polling, CI-fix detection, audit spawning, review handling, defer lifecycle, reaping rules) lives in the respective phase command files. Refer to:
- `/marvin-phase-triage` for triage, defer, and routing details
- `/marvin-phase-pr` for PR polling, CI-fix, audit, review, undraft, and docs details
- `/marvin-phase-ops` for reaping thresholds, stats recording, and digest generation

Worker-specific logic lives in worker command files:
- `/marvin-execute`, `/marvin-review`, `/marvin-ci-fix`, `/marvin-audit`, `/marvin-docs`

## Known issues and workarounds

- **Worktree upstream tracking**: Branches created from `origin/main` track main as upstream. Fixed by unsetting upstream on creation and using explicit push refspec `HEAD:refs/heads/<branch>`.
- **Orchestrator code freshness**: The orchestrator self-restarts every ~24 hours, picking up command file changes. For immediate updates, use `scripts/stop-marvin.sh` then `scripts/run-marvin.sh`.
- **Phase agent context**: Phase agents are short-lived Task agents. They load their command, do work, and exit. This keeps the EM's context small but means phase agents don't carry state between cycles — all coordination happens via the SQLite DB.
- **Spawn queue architecture**: Phase agents write worker spawn requests to the `spawn_queue` table instead of spawning workers directly. The orchestrator drains the queue after each phase and spawns workers itself. This is necessary because the Claude runtime terminates all background child Task agents when a parent Task agent exits — if phases spawned workers directly, workers would be killed almost immediately. The orchestrator is the long-lived process whose background Task agents survive.
- **Deferred ticket status activation**: Ticket status (`executing`/`exploring`) is ONLY set by the orchestrator when it actually spawns a worker from the spawn queue — never by the triage phase. This prevents zombie tickets that count toward concurrency limits but have no running worker. The triage phase stores worktree info on the ticket and includes `ticket_linear_id` in spawn_queue entries. When the orchestrator cancels pending spawns (due to concurrency limits), it rolls the ticket status back to `triaged`. The `spawn_queue` table has a `ticket_linear_id` column (migration 011) to support this rollback.

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
| `MARVIN_CONFIG` | Path to config JSON (command files read this, falls back to `config/default.json`) |
| `MARVIN_PLUGINS_DIR` | Path to MCP plugins directory (overrides default `<plugins_dir from config>`) |

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


