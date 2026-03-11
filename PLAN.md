# Marvin v2: Runtime-Agnostic Agent Coordination System

## Problem statement

Marvin is tightly coupled to Claude Code as both the model interface and tool execution runtime. Every agent — orchestrator, phases, workers — is a Claude Code session invoked via `claude -p "Run /command"`. This works but has significant costs:

1. **Session overhead**: Every phase spawn bootstraps a full Claude Code session (~5-10s), loads the 27KB CLAUDE.md, parses command files. Workers pay this tax every time.
2. **No model routing**: Everything runs on whatever model LiteLLM proxy returns (currently Opus). Triage (a structured JSON output) doesn't need Opus. CI-fix log parsing doesn't need Opus. We're burning Opus tokens on Haiku-grade work.
3. **Context window waste**: Each command file is a massive prompt (200-400 lines) that tells Claude Code *how to be an agent*. Most of that is boilerplate (checkpoint SQL, branch safety, error handling). The actual domain logic is ~20% of each file.
4. **No streaming/partial results**: Workers are black boxes until they exit. The dashboard only knows about them through phase checkpoint SQL writes.
5. **Single-harness lock-in**: The entire system only works with Claude Code. Can't use Codex, OpenCode, or raw API calls.
6. **Spawn queue exists solely because of Claude Code**: The spawn_queue table and its complexity exists because Claude Code kills child Task agents when parents exit. With a proper process model, you just... spawn processes.

## Design goals

1. **Keep what works**: SQLite state, safety invariants, phase model, triage prompts, dashboard, deployment
2. **Decouple model calls from tool execution**: Build a thin agent runtime that calls LiteLLM directly and executes tools itself
3. **Smart multi-provider model routing**: Use top-tier thinking models (Opus, GPT-5 Codex, Gemini) for worker coding tasks, with intelligent routing based on task characteristics and historical performance. All models accessed through LiteLLM.
4. **Feedback-driven routing**: Track model performance per task type, language, and complexity. Human feedback tunes the router over time — if Gemini is botching Go refactors, stop sending it Go refactors.
5. **Enable real-time mode**: Same skills, but coordinated by a present human instead of overnight polling
6. **Maintain multi-harness option**: Core logic shouldn't require Claude Code, but Claude Code remains *one way* to run it

## Architecture overview

```
┌─────────────────────────────────────────────────────┐
│                   Coordination Layer                 │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐    │
│  │ SQLite   │  │ Config   │  │ Spawn Manager  │    │
│  │ State DB │  │ (JSON)   │  │ (process mgr)  │    │
│  └──────────┘  └──────────┘  └────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │ Safety Hooks                                  │   │
│  │ (branch check, concurrency limit, no-merge)   │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                   Agent Runtime                      │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐    │
│  │ Model    │  │ Tool     │  │ Context Window │    │
│  │ Router   │  │ Executor │  │ Manager        │    │
│  └────┬─────┘  └──────────┘  └────────────────┘    │
│       │                                              │
│  ┌────┴─────────────────────────────────────────┐   │
│  │ LiteLLM (multi-provider)                      │   │
│  │                                                │   │
│  │  ┌─────────┐  ┌───────────┐  ┌────────────┐  │   │
│  │  │ Claude  │  │ GPT-5     │  │ Gemini     │  │   │
│  │  │ Opus    │  │ Codex     │  │ 2.5 Pro    │  │   │
│  │  └─────────┘  └───────────┘  └────────────┘  │   │
│  └───────────────────────┬──────────────────────┘   │
│                          │                           │
│  ┌───────────────────────┴──────────────────────┐   │
│  │ Feedback Loop                                 │   │
│  │ (outcome tracking, human ratings, router      │   │
│  │  weight adjustment per task×model)             │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  Tools: file_read, file_write, file_edit, bash,     │
│         glob, grep, linear_api, memory, git, gh     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                   Skills (portable)                  │
│                                                      │
│  triage, execute, explore, review, ci_fix,          │
│  audit, docs, digest, phase_ops, phase_triage,      │
│  phase_pr                                            │
└─────────────────────────────────────────────────────┘
```

## Incremental migration plan

### Phase 0: Extract skills from command files ✅ DONE

**Goal**: Separate the *domain logic* in each command file from the *Claude Code boilerplate*. This is a refactor of the existing system that pays for itself immediately by making commands easier to maintain.

**What changes**:
- Create `skills/` directory alongside `.claude/commands/`
- Each skill gets a clean prompt that contains ONLY the domain logic (what to do), not how to be an agent
- Command files become thin wrappers that load the skill prompt and add Claude Code-specific boilerplate (checkpoint SQL patterns, tool usage instructions)
- Triage prompt already lives in `prompts/triage.md` — this pattern extends to all workers

**Structure**:
```
skills/
  triage.md          # Pure judgment: given ticket, produce JSON assessment
  execute.md         # Pure workflow: explore → plan → implement → test → commit → PR
  explore.md         # Pure workflow: investigate → synthesize → report
  review.md          # Pure workflow: understand comments → fix → commit → push
  ci_fix.md          # Pure workflow: read logs → diagnose → fix → test → push
  audit.md           # Pure judgment: classify size → review architecture → risk score
  docs.md            # Pure workflow: read knowledge → update docs → PR
  phase_ops.md       # Pure ops: reap → stats → digest → trim
  phase_triage.md    # Pure coordination: poll → filter → triage → route
  phase_pr.md        # Pure coordination: poll PRs → detect issues → queue work
```

**Files touched**: Create `skills/`, modify `.claude/commands/*.md` to reference skills
**Risk**: Low — pure refactor, existing behavior unchanged
**Dependencies**: None

### Phase 1: Build the agent runtime ✅ DONE

**Goal**: A standalone TypeScript process that can run a skill by calling LiteLLM and executing tools, without Claude Code.

**What we build** (`runtime/`):
```
runtime/
  src/
    agent.ts          # Core agent loop: prompt → model → tool calls → execute → repeat
    tools/
      file.ts         # read, write, edit, glob, grep
      bash.ts         # Command execution with timeout, sandboxing
      git.ts          # git operations with safety hooks
      github.ts       # gh CLI wrapper
      linear.ts       # Linear API (replaces MCP plugin)
      memory.ts       # SQLite-backed memory (replaces MCP plugin)
    context.ts        # Context window management (truncation, summarization)
    router/
      router.ts       # Smart model router — picks provider per task
      feedback.ts     # Outcome tracking and human rating collection
      weights.ts      # Per-task×model scoring and weight adjustment
    config.ts         # Config loader (same JSON format)
    state.ts          # SQLite state manager (same schema)
    safety.ts         # Pre-execution hooks (branch check, concurrency, etc.)
    spawn.ts          # Process-based worker spawning (replaces spawn_queue)
  package.json
  tsconfig.json
```

**Core agent loop** (agent.ts):
```typescript
async function runAgent(skill: string, args: Record<string, string>, opts: AgentOpts) {
  const prompt = loadSkill(skill, args)
  const routingContext = {
    skill,
    language: args.language,          // detected from target files
    complexity: args.complexity,       // from triage
    taskType: classifyTask(skill, args), // e.g. 'go_refactor', 'ruby_bugfix', 'ts_new_feature'
  }
  const model = opts.model ?? router.selectModel(routingContext)
  const messages: Message[] = [{ role: 'system', content: prompt }]

  // Track for feedback
  const run = await feedback.startRun({ skill, model, routingContext, ticketId: args.ticketId })

  while (true) {
    const response = await litellm.chat(model, messages, { tools: TOOL_DEFS })

    if (response.stop_reason === 'end_turn') break

    for (const toolCall of response.tool_calls) {
      await safety.preCheck(toolCall)
      const result = await tools.execute(toolCall)
      messages.push({ role: 'tool', content: result, tool_call_id: toolCall.id })
      await state.heartbeat(opts.ticketId, skill)
    }

    if (tokenCount(messages) > MAX_CONTEXT * 0.8) {
      messages = await context.compact(messages)
    }

    run.trackTokens(response.usage)
  }

  // Record outcome for feedback loop
  await run.complete({ success: true, tokensUsed: run.totalTokens })
}
```

**Smart model routing** (router.ts):

The router uses top-tier thinking models for all worker tasks (coding, analysis, judgment) and routes between providers based on task characteristics and learned performance. No Haiku/Sonnet downgrading — every task gets a frontier model, but the *right* frontier model for that type of work.

```typescript
// All workers use frontier thinking models — the question is WHICH one
const PROVIDER_POOL = {
  'claude-opus':     { id: 'anthropic/claude-opus-4', strengths: ['planning', 'architecture', 'ruby', 'go'] },
  'gpt5-codex':      { id: 'openai/gpt-5-codex', strengths: ['typescript', 'python', 'test_generation'] },
  'gemini-pro':      { id: 'google/gemini-2.5-pro', strengths: ['large_context', 'refactoring', 'analysis'] },
}

// Default routing — starting point before feedback data accumulates
const DEFAULT_ROUTING: Record<string, string> = {
  // Executor subtasks
  'execute:explore':     'claude-opus',      // Deep codebase analysis
  'execute:plan':        'claude-opus',      // Architecture decisions
  'execute:implement':   'gpt5-codex',       // Raw coding speed
  'execute:test':        'gpt5-codex',       // Test generation
  // Worker types
  'review':              'claude-opus',      // Needs to understand intent behind review comments
  'ci_fix':              'gpt5-codex',       // Log parsing + targeted code fixes
  'audit':               'gemini-pro',       // Large context for full-PR review
  'explore':             'claude-opus',      // Deep analysis
  'docs':                'gemini-pro',       // Large context, writing
  // Phases (orchestration, not coding — can use any)
  'triage':              'claude-opus',      // Structured judgment
  'phase_ops':           'claude-opus',      // Mechanical
  'phase_triage':        'claude-opus',      // Needs Linear API tool use
  'phase_pr':            'claude-opus',      // Needs GitHub API tool use
}

// Language-specific overrides (learned over time via feedback)
const LANGUAGE_AFFINITIES: Record<string, Record<string, number>> = {
  // model -> language -> score multiplier (1.0 = neutral, >1 = prefer, <1 = avoid)
  'claude-opus':  { go: 1.3, ruby: 1.2, swift: 1.1 },
  'gpt5-codex':   { typescript: 1.3, python: 1.2, 'helm': 1.1 },
  'gemini-pro':   { terraform: 1.2, python: 1.1 },
}

function selectModel(ctx: RoutingContext): string {
  // 1. Check if there's a learned routing override from feedback
  const learned = weights.getBestModel(ctx.taskType, ctx.language)
  if (learned && learned.confidence > 0.7) return learned.model

  // 2. Check language affinity
  if (ctx.language) {
    const scores = Object.entries(PROVIDER_POOL).map(([name, _]) => ({
      name,
      score: (LANGUAGE_AFFINITIES[name]?.[ctx.language] ?? 1.0)
    }))
    const best = maxBy(scores, s => s.score)
    if (best.score > 1.1) return best.name  // meaningful preference
  }

  // 3. Fall back to default routing
  return DEFAULT_ROUTING[ctx.skill] ?? 'claude-opus'
}
```

**Per-phase model switching within executors**:

Executors are the most expensive workers and benefit most from smart routing. Instead of using one model for the entire run, the executor can switch models between phases:

```typescript
// In execute skill, the agent runtime switches models per phase
const EXECUTOR_PHASE_MODELS = {
  'pre-check':        'claude-opus',    // Quick, any model works
  'explore':          'claude-opus',    // Deep codebase understanding
  'plan':             'claude-opus',    // Architecture decisions
  'implement':        null,             // Router picks based on language + feedback
  'test':             null,             // Router picks based on language + feedback
  'commit-push':      'claude-opus',    // Mechanical, any model works
  'pr-creation':      'claude-opus',    // Mechanical
  'knowledge-capture': 'claude-opus',   // Reflection
}
```

The `null` entries mean "ask the router" — those are the phases where language-specific performance matters most and where feedback data is most valuable.

**Files**: New `runtime/` directory
**Risk**: Medium — core infrastructure, needs thorough testing
**Dependencies**: Phase 0 (skills must be extracted first)

### Phase 2: Replace spawn_queue with process spawning ✅ DONE

**Goal**: Workers spawn as OS processes, not Claude Code Task agents. The spawn_queue pattern becomes unnecessary.

**What changes**:
- Orchestrator runs as a Node process (`runtime/orchestrator.ts`)
- Phases run as function calls within the orchestrator (not separate processes)
- Workers spawn via `child_process.fork()` or `spawn()`
- Concurrency limit enforced by the process manager, not SQL counting
- Heartbeats become in-process signals, not SQL UPDATEs

**Spawn manager** (spawn.ts):
```typescript
class SpawnManager {
  private workers = new Map<string, ChildProcess>()
  private maxWorkers = 8

  async spawn(skill: string, args: Record<string, string>) {
    if (this.workers.size >= this.maxWorkers) {
      return { queued: true }  // Or reject, depending on policy
    }

    const proc = fork('./agent.ts', { env: { SKILL: skill, ARGS: JSON.stringify(args) } })
    this.workers.set(args.ticketId, proc)

    proc.on('exit', (code) => {
      this.workers.delete(args.ticketId)
      // Update DB status
    })

    proc.on('message', (msg) => {
      // Handle heartbeats, progress updates, streaming output
    })
  }

  reap(staleThreshold: number) {
    for (const [id, proc] of this.workers) {
      if (proc.lastHeartbeat < Date.now() - staleThreshold) {
        proc.kill()
        this.workers.delete(id)
      }
    }
  }
}
```

**What gets deleted**:
- `spawn_queue` table (migration to drop it)
- Spawn queue drain logic in marvin-cycle.md
- `ticket_linear_id` rollback logic
- All the "why spawn_queue exists" documentation

**What stays**:
- SQLite for ticket state, PR tracking, run tracking (still needed for dashboard)
- Heartbeat table (dashboard still reads it)
- Cycle events (dashboard still reads them)

**Files touched**: New `runtime/orchestrator.ts`, `runtime/spawn.ts`; eventually deprecate `spawn_queue` migration
**Risk**: Medium-high — changes core lifecycle management
**Dependencies**: Phase 1 (agent runtime must exist)

### Phase 3: Inline phases as function calls ✅ DONE

**Goal**: Phase agents don't need to be separate processes. They're stateless functions that read DB → do work → write DB.

**What changes**:
- `phase_ops`, `phase_triage`, `phase_pr` become TypeScript modules
- Orchestrator calls them as functions, not by spawning subprocesses
- No context window overhead per phase — they share the orchestrator's context
- Model calls happen within each phase as needed (triage uses Opus for judgment, PR phase uses Opus for review detection)

**Orchestrator becomes**:
```typescript
async function cycle() {
  await heartbeat('starting')

  await phaseOps()        // Direct function call
  await phaseTriage()     // Direct function call
  // Workers spawned by spawnManager during triage

  await phasePR()         // Direct function call
  // CI-fix/audit/review/docs workers spawned during PR phase

  await heartbeat('sleeping')
  await sleep(config.cycle_interval_seconds * 1000)
}
```

**What stays the same**: The dashboard reads SQLite and works identically. Phases still write to the same tables.

**Files**: New `runtime/phases/ops.ts`, `runtime/phases/triage.ts`, `runtime/phases/pr.ts`
**Risk**: Medium — phases need to replicate exact DB operations from command files
**Dependencies**: Phase 2 (process spawning for workers)

### Phase 4: Model performance feedback loop ✅ DONE

**Goal**: Track which models perform well on which task types, and let human feedback tune the router over time. This is the learning system that makes multi-provider routing actually work instead of guessing.

#### Automatic outcome tracking

Every agent run records structured outcomes:

```typescript
// feedback.ts
interface RunOutcome {
  id: string
  skill: string                    // 'execute', 'review', 'ci_fix', etc.
  phase: string                    // 'explore', 'implement', 'test' (for executors)
  model: string                    // 'claude-opus', 'gpt5-codex', 'gemini-pro'
  task_type: string                // 'go_refactor', 'ruby_bugfix', 'ts_new_feature'
  language: string | null          // Primary language of the work
  complexity: number               // From triage (1-5)
  ticket_id: string

  // Automatic signals
  success: boolean                 // Did the skill complete without error?
  tests_passed: boolean | null     // Did tests pass on first run?
  test_retries: number             // How many test fix attempts
  ci_passed: boolean | null        // Did CI pass on the resulting PR?
  pr_review_rounds: number         // How many review rounds before approval
  tokens_used: number              // Total tokens consumed
  duration_seconds: number         // Wall clock time
  tool_call_count: number          // How many tool invocations

  // Human feedback (filled in later via dashboard)
  human_rating: number | null      // 1-5 scale (null = not yet rated)
  human_notes: string | null       // Free-text feedback
  rating_dimensions: {
    code_quality: number | null    // 1-5: was the code clean, idiomatic?
    correctness: number | null     // 1-5: did it solve the problem correctly?
    efficiency: number | null      // 1-5: was the approach efficient (not over-engineered)?
    test_quality: number | null    // 1-5: were the tests meaningful?
  } | null

  created_at: string
  rated_at: string | null
}
```

#### DB schema (new migration)

```sql
CREATE TABLE model_runs (
  id TEXT PRIMARY KEY,
  skill TEXT NOT NULL,
  phase TEXT,
  model TEXT NOT NULL,
  task_type TEXT NOT NULL,
  language TEXT,
  complexity INTEGER,
  ticket_id TEXT,
  ticket_identifier TEXT,          -- e.g. GM-1234 for display

  -- Automatic signals
  success INTEGER NOT NULL DEFAULT 0,
  tests_passed INTEGER,
  test_retries INTEGER DEFAULT 0,
  ci_passed INTEGER,
  pr_review_rounds INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,

  -- Human feedback
  human_rating INTEGER,            -- 1-5
  human_notes TEXT,
  code_quality INTEGER,            -- 1-5
  correctness INTEGER,             -- 1-5
  efficiency INTEGER,              -- 1-5
  test_quality INTEGER,            -- 1-5

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  rated_at TEXT
);

CREATE INDEX idx_model_runs_model ON model_runs(model);
CREATE INDEX idx_model_runs_task_type ON model_runs(task_type);
CREATE INDEX idx_model_runs_unrated ON model_runs(human_rating) WHERE human_rating IS NULL;

-- Routing weights (learned from feedback)
CREATE TABLE routing_weights (
  task_type TEXT NOT NULL,
  language TEXT,                   -- NULL means "any language"
  model TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 1.0, -- Higher = prefer this model
  sample_count INTEGER DEFAULT 0,  -- How many runs inform this score
  confidence REAL DEFAULT 0.0,     -- 0-1, based on sample_count and consistency
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (task_type, COALESCE(language, ''), model)
);
```

#### Weight calculation (weights.ts)

```typescript
function recalculateWeights(taskType: string, language?: string) {
  // Get all runs for this task type (and optionally language)
  const runs = db.getRunsForTaskType(taskType, language, { minRuns: 3 })

  for (const model of PROVIDER_POOL) {
    const modelRuns = runs.filter(r => r.model === model)
    if (modelRuns.length < 3) continue  // Not enough data

    // Composite score from multiple signals
    const score = calculateCompositeScore(modelRuns)
    const confidence = Math.min(modelRuns.length / 20, 1.0)  // Max confidence at 20 runs

    db.upsertWeight(taskType, language, model, score, modelRuns.length, confidence)
  }
}

function calculateCompositeScore(runs: RunOutcome[]): number {
  // Weighted blend of signals
  const weights = {
    success_rate:      0.25,   // Did it complete?
    human_rating:      0.30,   // Human judgment (most important)
    ci_pass_rate:      0.15,   // Did CI pass?
    test_first_pass:   0.10,   // Tests pass without retries?
    review_efficiency: 0.10,   // Fewer review rounds = better
    token_efficiency:  0.10,   // Cost per successful run
  }

  const successRate = mean(runs.map(r => r.success ? 1 : 0))
  const humanRating = mean(runs.filter(r => r.human_rating).map(r => r.human_rating! / 5))
  const ciPassRate = mean(runs.filter(r => r.ci_passed !== null).map(r => r.ci_passed ? 1 : 0))
  const testFirstPass = mean(runs.filter(r => r.tests_passed !== null).map(r => r.test_retries === 0 ? 1 : 0))
  const reviewEfficiency = mean(runs.map(r => Math.max(0, 1 - r.pr_review_rounds * 0.2)))
  const tokenEfficiency = 1 - normalize(mean(runs.map(r => r.tokens_used)))  // Lower tokens = higher score

  return (
    weights.success_rate * successRate +
    weights.human_rating * (humanRating || successRate) +  // Fall back to success rate if no human ratings
    weights.ci_pass_rate * (ciPassRate || successRate) +
    weights.test_first_pass * (testFirstPass || 0.5) +
    weights.review_efficiency * (reviewEfficiency || 0.5) +
    weights.token_efficiency * tokenEfficiency
  )
}
```

#### Human feedback via dashboard

New "Model Performance" tab on the dashboard:

```
┌─────────────────────────────────────────────────────────────┐
│ Model Performance                                            │
│                                                              │
│ ┌─── Unrated Runs (3) ───────────────────────────────────┐  │
│ │                                                         │  │
│ │  GM-1847 "Fix push notification retry"                  │  │
│ │  Model: gpt5-codex  │  Language: Go  │  Complexity: 2   │  │
│ │  ✅ Success  │  ✅ Tests passed  │  ⏳ CI pending       │  │
│ │  PR: #482  │  Tokens: 45,230  │  Duration: 4m 12s      │  │
│ │                                                         │  │
│ │  Rate: ★ ★ ★ ★ ☆   [Submit]                           │  │
│ │  Dimensions: Code ★★★★☆  Correct ★★★★★                │  │
│ │              Efficient ★★★☆☆  Tests ★★★★☆              │  │
│ │  Notes: [_________________________________]             │  │
│ │                                                         │  │
│ └─────────────────────────────────────────────────────────┘  │
│                                                              │
│ ┌─── Routing Weights ────────────────────────────────────┐  │
│ │                                                         │  │
│ │  Task Type        │ Opus    │ GPT-5   │ Gemini │ Runs  │  │
│ │  ─────────────────┼─────────┼─────────┼────────┼────── │  │
│ │  go_bugfix         │ 0.85 ★ │ 0.72    │ 0.68   │  14   │  │
│ │  ts_new_feature    │ 0.78    │ 0.91 ★ │ 0.75   │  11   │  │
│ │  ruby_refactor     │ 0.88 ★ │ 0.65    │ 0.71   │   8   │  │
│ │  go_new_feature    │ 0.82    │ 0.79    │ 0.84 ★ │   6   │  │
│ │  terraform_config  │ 0.70    │ 0.68    │ 0.82 ★ │   5   │  │
│ │                                                         │  │
│ │  ★ = currently routed to this model                     │  │
│ │  [Override: force model for task type ▾]                │  │
│ └─────────────────────────────────────────────────────────┘  │
│                                                              │
│ ┌─── Recent Performance ─────────────────────────────────┐  │
│ │                                                         │  │
│ │  Last 7 days: 23 runs, 87% success rate                │  │
│ │  By model: Opus 9/10 (90%) │ GPT-5 7/8 (88%)          │  │
│ │            Gemini 4/5 (80%)                             │  │
│ │  Avg human rating: Opus 4.2 │ GPT-5 3.9 │ Gemini 3.7  │  │
│ │                                                         │  │
│ └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Dashboard API endpoints for feedback:
- `POST /api/model-runs/:id/rate` — Submit human rating for a run
- `GET /api/model-runs/unrated` — List runs awaiting human feedback
- `GET /api/routing-weights` — Current routing weights table
- `POST /api/routing-overrides` — Force a model for a task type (manual override)
- `GET /api/model-stats` — Aggregate performance stats

#### Manual routing overrides

Sometimes you just know — "stop sending Go work to Gemini, it keeps messing up error handling." The dashboard supports manual overrides that bypass the learned weights:

```sql
CREATE TABLE routing_overrides (
  task_type TEXT NOT NULL,
  language TEXT,
  model TEXT NOT NULL,             -- Force this model
  reason TEXT,                     -- Why the override exists
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT,                 -- NULL = permanent, or date to auto-expire
  PRIMARY KEY (task_type, COALESCE(language, ''))
);
```

Overrides take priority over learned weights. They can expire (useful for "try this for a week and see").

#### Feedback collection workflow

1. **Worker completes** → automatic signals recorded (success, tests, tokens, duration)
2. **CI runs** → automatic signal updated (ci_passed)
3. **PR reviewed** → automatic signal updated (review_rounds)
4. **Human rates** → dashboard shows unrated runs, human provides 1-5 + optional dimensions + notes
5. **Weights recalculated** → on each new rating, recalculate for affected task_type×language
6. **Router uses updated weights** → next matching task gets routed based on new data

The human feedback step is optional but heavily weighted. The system works on automatic signals alone, but human ratings provide the most valuable signal because they capture code quality, idiomaticity, and correctness that automated metrics miss.

**Files**: New `runtime/router/`, new migration, dashboard enhancements
**Risk**: Low-medium (additive, router falls back to defaults without feedback data)
**Dependencies**: Phase 1 (agent runtime)

### Phase 5: Real-time coordination mode ✅ DONE

**Goal**: Same skills, but triggered by a human in real-time instead of polling.

**What we add**:
- WebSocket server on the dashboard (or new port)
- Human can: create ad-hoc tasks, assign agents, see streaming output, approve/reject plans
- Agents broadcast partial results as they work (not just on completion)
- Human can interrupt an agent mid-skill and redirect it

**This is additive** — autonomous mode keeps running as before. Real-time mode is an alternative entry point that uses the same skills, tools, and runtime.

**Architecture**:
```
Dashboard (existing, enhanced)
  ├─ Autonomous tab (current functionality)
  ├─ Models tab (Phase 4 feedback UI)
  └─ Assist tab (new)
       ├─ Task input → create ad-hoc task
       ├─ Agent grid → see running agents, streaming output
       ├─ Plan view → approve/reject executor plans
       └─ Chat → direct agent interaction
```

**Files**: Enhanced `scripts/dashboard.py` or new frontend, new `runtime/realtime.ts`
**Risk**: Low-medium (additive, doesn't break existing flow)
**Dependencies**: Phase 1 (agent runtime)

### Phase 6: Multi-harness support ✅ DONE

**Goal**: Skills compile to Claude Code commands, Codex tasks, and raw API formats.

**What we build**:
- `harness/claude-code.ts` — Generates `.claude/commands/*.md` from `skills/*.md`
- `harness/codex.ts` — Generates Codex task definitions
- `harness/raw-api.ts` — Direct LiteLLM agent loop (Phase 1's runtime)

**This lets the same triage/execute/review logic run on any harness**, with Claude Code as a "compatibility mode" for cases where you want the full Claude Code experience (MCP plugins, interactive debugging, etc.).

Note: multi-harness is interesting but lower priority than the model routing and feedback loop. The real value is in Phase 1-4. This is here for completeness and becomes relevant if we want to compare Claude Code vs. Codex vs. raw API as *execution runtimes* (separate from the model routing question — you could use the raw API runtime to call Opus, GPT-5, or Gemini).

**Files**: New `harness/` directory
**Risk**: Low (additive)
**Dependencies**: Phase 0 (skills extracted)

---

## What stays unchanged throughout all phases

| Component | Why it stays |
|-----------|-------------|
| SQLite schema | Dashboard reads it, it's the right tool for durable state |
| Config format | JSON, works everywhere |
| Safety invariants | These are the discipline layer — they transcend runtime |
| Dashboard | Python HTTP server reading SQLite — runtime-agnostic |
| Deployment (K8s) | Container runs whatever runtime, same PVCs and secrets |
| Triage prompt | Pure AI judgment, already extracted to `prompts/triage.md` |
| Git/GitHub conventions | Worktrees, branch naming, draft PRs — git doesn't care about runtime |
| Linear integration | API calls are API calls, whether via MCP or direct |
| Deep Thought | Separate orchestrator, can migrate on its own timeline |

## Model routing philosophy

**Every task gets a frontier thinking model.** We're not downgrading triage to Haiku or reviews to Sonnet — we're routing between the best models from different providers based on what they're actually good at.

The hypothesis: different frontier models have different strengths for different coding tasks. Opus might be better at Go architecture decisions. GPT-5 Codex might be faster at cranking out TypeScript implementations. Gemini might handle large-context PR audits better. Instead of guessing, we measure and learn.

### Why this beats single-provider

| Approach | Problem |
|----------|---------|
| All Opus | Paying Opus prices for tasks where GPT-5 might be faster/cheaper/better |
| Cost-tier routing (Haiku/Sonnet/Opus) | Haiku/Sonnet produce measurably worse code — you save on model cost but pay in review rounds, CI failures, and human cleanup |
| Static multi-provider | You guess which model is best for what, and guesses go stale as models update |
| **Learned multi-provider (this plan)** | Automatic + human signals discover actual performance. Router adapts as models improve. You get the best model for each task. |

### Cold start

Before feedback data exists, the router uses `DEFAULT_ROUTING` (static config). This is your best guess today. As runs accumulate and you rate them, the router learns. After ~20 rated runs per task type, learned weights dominate.

You can accelerate cold start by running the same ticket through multiple models (A/B testing mode, optional) and comparing results. This is expensive but gives you high-quality comparison data fast.

### Config

```json
{
  "routing": {
    "providers": {
      "claude-opus": {
        "litellm_model": "anthropic/claude-opus-4",
        "enabled": true,
        "cost_per_1k_input": 0.015,
        "cost_per_1k_output": 0.075
      },
      "gpt5-codex": {
        "litellm_model": "openai/gpt-5-codex",
        "enabled": true,
        "cost_per_1k_input": 0.012,
        "cost_per_1k_output": 0.060
      },
      "gemini-pro": {
        "litellm_model": "google/gemini-2.5-pro",
        "enabled": true,
        "cost_per_1k_input": 0.010,
        "cost_per_1k_output": 0.040
      }
    },
    "min_runs_for_learned_routing": 5,
    "confidence_threshold": 0.7,
    "recalculate_on_every_nth_rating": 3,
    "ab_testing_enabled": false
  }
}
```

## Migration safety

Each phase is independently shippable:
- **Phase 0** is a pure refactor — roll back by reverting the command file changes
- **Phase 1** runs alongside Claude Code — new runtime doesn't touch existing system
- **Phase 2** can be feature-flagged: `config.spawn_mode: "process" | "claude-code"`
- **Phase 3** can be feature-flagged: `config.phase_mode: "inline" | "subprocess"`
- **Phase 4** is purely additive — feedback tables and dashboard tab, router falls back to defaults without data
- **Phase 5** is purely additive
- **Phase 6** is purely additive

At any point, `claude -p "Run /marvin-cycle"` still works as the fallback.

## Open questions

1. **Tool parity**: Claude Code's Edit tool has sophisticated conflict detection and unique-match requirements. Do we reimplement this or use a simpler search-replace?
2. **MCP plugin replacement**: Linear MCP and memory MCP are npm packages with their own APIs. Do we wrap their APIs directly or keep MCP as an option?
3. **Context window management**: Claude Code handles this implicitly. Our runtime needs explicit strategies — summarize old messages? Sliding window? RAG over conversation history?
4. **Testing the runtime**: How do we test the agent loop itself? Mock LiteLLM responses? Record/replay?
5. **Bus vs. polling**: Phase 5 (real-time mode) could use a message bus (NATS) or simpler WebSocket pub/sub. For a single-node system, WebSockets are probably sufficient. Bus becomes relevant if we distribute across nodes.
6. **Tool format differences across providers**: Claude uses XML-style tool calls, OpenAI uses JSON function calling, Gemini has its own format. LiteLLM normalizes most of this, but there are edge cases (e.g., how each model handles multi-tool-call responses, streaming tool calls, thinking tokens). Need to verify LiteLLM handles all three providers consistently for agentic tool use loops.
7. **A/B testing cost**: Running the same ticket through 2-3 models for comparison data is 2-3x the cost. When is this worth it vs. just accumulating data from normal routing? Probably worth it for the first ~50 runs to build a baseline, then turn it off.
8. **Rating fatigue**: If Marvin produces 10-20 PRs per day, rating every one is tedious. Consider: only prompt for ratings on runs where automatic signals are ambiguous (success but high token count, or success but many test retries), and skip rating obviously-good runs (success, tests passed first try, CI passed, low token count).
