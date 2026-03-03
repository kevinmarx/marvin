# Setup guide

## Prerequisites

- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- [Linear MCP plugin](https://github.com/linear/linear-mcp) configured
- [SQLite3](https://sqlite.org/) installed
- Python 3.10+ (for dashboard)
- Git with worktree support

## First-time setup

### 1. Create your config

```bash
cp config/example.json config/default.json
```

Edit `config/default.json` with your values:

| Key | Description | Example |
|-----|-------------|---------|
| `team` | Your Linear team name | `"Engineering"` |
| `assignee` | Linear assignee for auto-triaged tickets | `"me"` |
| `repos` | Map of repo names to local paths | `{"my-repo": "/path/to/my-repo"}` |
| `worktree_root` | Directory for git worktrees | `"/path/to/worktrees"` |
| `github_org` | Your GitHub organization | `"my-org"` |
| `github_user` | Your GitHub username | `"myuser"` |
| `linear_workspace_slug` | Your Linear workspace slug (from URL) | `"my-workspace"` |
| `branch_prefix` | Prefix for branches Marvin creates | `"users/myuser"` |
| `git_name` | Git author name for commits | `"Your Name"` |
| `git_email` | Git author email for commits | `"you@example.com"` |
| `plugins_dir` | Path to MCP plugins directory | `"/path/to/plugins"` |
| `marvin_repo_path` | Path to this Marvin repo | `"/path/to/marvin"` |
| `labels.platform` | Linear label for platform tickets | `"Platform"` |

### 2. Initialize the database

```bash
./scripts/setup.sh
```

This creates `~/.marvin/state/marvin.db` with the full schema.

### 3. Set up MCP plugins

Marvin needs these MCP plugins available:
- `linear-mcp` — Linear issue tracking
- `local-memory-mcp` — Cross-session memory

Point `plugins_dir` in your config to the directory containing these plugins.

### 4. Run Marvin

```bash
# Single test cycle
./scripts/run-cycle.sh

# Full orchestrator with auto-restart
./scripts/run-marvin.sh
```

### 5. View the dashboard

```bash
python3 scripts/dashboard.py
# Opens at http://localhost:7777
```

## Deep Thought setup (optional)

Deep Thought is the observability scanner that creates tickets for Marvin. It requires additional setup:

### 1. Create Deep Thought config

```bash
cp config/deep-thought.example.json config/deep-thought.json
```

Edit with your values. Additional keys needed:
- `datadog.monitor_tags` — tags to filter Datadog monitors
- `datadog.service_filter` — service name pattern for APM queries

### 2. Set Datadog credentials

```bash
export DD_API_KEY="your-datadog-api-key"
export DD_APP_KEY="your-datadog-app-key"
```

### 3. Initialize and run

```bash
./scripts/dt-setup.sh
./scripts/run-deep-thought.sh
```

## Remote deployment (Kubernetes)

See `deploy/` directory for Kubernetes manifests. Create `config/remote.json` from `config/remote.example.json` with container-appropriate paths.

```bash
cp config/remote.example.json config/remote.json
# Edit config/remote.json with container paths
export MARVIN_REGISTRY=your-ecr-repo.dkr.ecr.region.amazonaws.com
./deploy/k8s/deploy.sh
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `MARVIN_CONFIG` | Path to config JSON (default: `config/default.json`) |
| `MARVIN_REMOTE` | Set to `"1"` for container deployment |
| `MARVIN_PLUGINS_DIR` | Override plugins directory |
| `DEEP_THOUGHT_CONFIG` | Path to Deep Thought config |
| `DEEP_THOUGHT_REMOTE` | Set to `"1"` for container deployment |
| `DD_API_KEY` | Datadog API key (for Deep Thought) |
| `DD_APP_KEY` | Datadog App key (for Deep Thought) |
