import { z } from 'zod'

// ─── Config ─────────────────────────────────────────────────────────

export const ProviderConfigSchema = z.object({
  litellm_model: z.string(),
  enabled: z.boolean().default(true),
  cost_per_1k_input: z.number().optional(),
  cost_per_1k_output: z.number().optional(),
  cost_tier: z.enum(['high', 'medium', 'low']).optional(),
  max_context: z.number().optional(),
})

export const RoutingConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema),
  min_runs_for_learned_routing: z.number().default(5),
  confidence_threshold: z.number().default(0.7),
  recalculate_on_every_nth_rating: z.number().default(3),
  ab_testing_enabled: z.boolean().default(false),
})

export const LimitsConfigSchema = z.object({
  defer_max_followups: z.number().default(3),
  defer_min_interval_hours: z.number().default(24),
  defer_nudge_after_days: z.number().default(7),
  ci_fix_max_attempts: z.number().default(5),
  ci_fix_min_interval_minutes: z.number().default(10),
  ci_fix_max_files: z.number().default(5),
  executor_max_test_retries: z.number().default(2),
  stale_executor_minutes: z.number().default(120),
  stale_reviewer_minutes: z.number().default(60),
  stale_ci_fix_minutes: z.number().default(30),
  stale_auditor_minutes: z.number().default(30),
  stale_docs_minutes: z.number().default(30),
  rebase_max_attempts: z.number().default(3),
  rebase_min_interval_minutes: z.number().default(10),
  max_concurrent_workers: z.number().default(8),
  idle_multiplier_max: z.number().default(4),
})

export const MarvinConfigSchema = z.object({
  team: z.string(),
  assignee: z.string().default('me'),
  linear_user: z.string().optional(),
  ticket_states: z.array(z.string()).default(['triage', 'backlog', 'unstarted']),
  claim_unassigned: z.boolean().default(false),
  repos: z.record(z.string(), z.string()),
  worktree_root: z.string(),
  branch_prefix: z.string(),
  complexity_threshold: z.number().default(2),
  confidence_threshold: z.number().default(0.7),
  digest_interval_minutes: z.number().default(60),
  cycle_interval_seconds: z.number().default(1800),
  self_restart_after_cycles: z.number().default(48),
  state_db: z.string().default('~/.marvin/state/marvin.db'),
  log_dir: z.string().default('~/.marvin/logs'),
  backup_dir: z.string().default('~/.marvin/backups'),
  github_org: z.string(),
  github_user: z.string(),
  linear_workspace_slug: z.string(),
  marvin_repo_path: z.string(),
  plugins_dir: z.string().optional(),
  git_name: z.string().optional(),
  git_email: z.string().optional(),
  labels: z.object({
    platform: z.string().default('Platform'),
  }).default({}),
  limits: LimitsConfigSchema.default({}),
  routing: RoutingConfigSchema.optional(),
})

export type MarvinConfig = z.infer<typeof MarvinConfigSchema>
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

// ─── Model routing ──────────────────────────────────────────────────

export type ProviderName = string // e.g. 'claude-opus', 'gpt5-codex', 'gemini-pro'

export type SkillName =
  | 'execute' | 'explore' | 'review' | 'ci_fix' | 'audit'
  | 'docs' | 'reassign' | 'digest'
  | 'triage' | 'phase_ops' | 'phase_triage' | 'phase_pr'
  | 'orchestrator'
  | 'dt_orchestrator' | 'dt_phase_ops' | 'dt_phase_alerts' | 'dt_phase_telemetry'
  | 'dt_phase_codebase' | 'dt_scan_todos' | 'dt_scan_deps' | 'dt_scan_patterns'

export type ExecutorPhase =
  | 'pre-check' | 'explore' | 'plan' | 'implement'
  | 'test' | 'commit-push' | 'pr-creation' | 'knowledge-capture'

export interface RoutingContext {
  skill: SkillName
  phase?: ExecutorPhase
  language?: string
  complexity?: number
  taskType?: string // e.g. 'go_refactor', 'ruby_bugfix', 'ts_new_feature'
}

export interface RoutingDecision {
  model: ProviderName
  litellmModel: string // e.g. 'anthropic/claude-opus-4'
  reason: string
}

export interface LearnedWeight {
  model: ProviderName
  score: number
  confidence: number
  sampleCount: number
}

// ─── Agent runtime ──────────────────────────────────────────────────

export interface AgentOpts {
  skill: SkillName
  args: Record<string, string>
  model?: ProviderName
  ticketId?: string
  identifier?: string
  phase?: ExecutorPhase
  maxTurns?: number
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ToolResult {
  output: string
  error?: string
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
}

// ─── Tool definitions ───────────────────────────────────────────────

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
}

// ─── Feedback ───────────────────────────────────────────────────────

export interface RunOutcome {
  id: string
  skill: SkillName
  phase?: string
  model: ProviderName
  taskType: string
  language?: string
  complexity?: number
  ticketId?: string
  ticketIdentifier?: string

  // Automatic signals
  success: boolean
  testsPassed?: boolean
  testRetries: number
  ciPassed?: boolean
  prReviewRounds: number
  tokensUsed: number
  durationSeconds: number
  toolCallCount: number

  // Human feedback
  humanRating?: number
  humanNotes?: string
  codeQuality?: number
  correctness?: number
  efficiency?: number
  testQuality?: number

  createdAt: string
  ratedAt?: string
}

// ─── Safety ─────────────────────────────────────────────────────────

export interface SafetyCheck {
  name: string
  check: (toolCall: ToolCall, context: SafetyContext) => Promise<SafetyResult>
}

export interface SafetyContext {
  worktreePath?: string
  branchName?: string
  repoPath?: string
  skill: SkillName
}

export interface SafetyResult {
  allowed: boolean
  reason?: string
}
