import Database from 'better-sqlite3'
import type { RoutingContext, RoutingDecision, ProviderName, ProviderConfig } from '../types.js'
import { getBestModel } from './weights.js'

// ─── Cost tiers ─────────────────────────────────────────────────────
// Relative cost ranking — used for estimation when per-token pricing
// isn't configured. Approximate $/1M input tokens at each tier.

export type CostTier = 'high' | 'medium' | 'low'

const COST_TIER_RATES: Record<CostTier, { input: number; output: number }> = {
  high:   { input: 15.0,  output: 75.0 },  // e.g. Opus
  medium: { input: 3.0,   output: 15.0 },  // e.g. GPT-5, Gemini Pro
  low:    { input: 1.0,   output: 4.0 },   // e.g. Sonnet, GPT-4o
}

// ─── Default provider pool ──────────────────────────────────────────

interface ProviderPoolEntry {
  litellmModel: string
  costTier: CostTier
  maxContext: number
}

const DEFAULT_PROVIDER_POOL: Record<ProviderName, ProviderPoolEntry> = {
  'claude-opus':   { litellmModel: 'anthropic/claude-opus-4',   costTier: 'high',   maxContext: 200000 },
  'gpt5-codex':    { litellmModel: 'openai/gpt-5-codex',       costTier: 'medium', maxContext: 128000 },
  'gemini-pro':    { litellmModel: 'google/gemini-2.5-pro',     costTier: 'medium', maxContext: 1000000 },
  'claude-sonnet': { litellmModel: 'anthropic/claude-sonnet-4', costTier: 'low',    maxContext: 200000 },
  'gpt4o':         { litellmModel: 'openai/gpt-4o',            costTier: 'low',    maxContext: 128000 },
}

// ─── Default routing table ──────────────────────────────────────────
// Maps "skill" or "skill:phase" to the default model.
// Key insight: triage, ci-fix, docs, phase-ops, and phase-pr don't
// need frontier reasoning. Sonnet/GPT-4o save significant cost at
// equivalent quality for their task types.

const DEFAULT_ROUTES: Record<string, ProviderName> = {
  // Executor subtasks — keep frontier models for coding
  'execute:explore':   'claude-opus',
  'execute:plan':      'claude-opus',
  'execute:implement': 'gpt5-codex',
  'execute:test':      'gpt5-codex',
  // Workers — match complexity to model tier
  'review':            'claude-opus',       // Needs to understand reviewer intent
  'ci_fix':            'claude-sonnet',     // Log parsing + targeted fixes — doesn't need Opus
  'audit':             'gemini-pro',        // Large context for full-PR review
  'explore':           'claude-opus',       // Deep analysis
  'docs':              'claude-sonnet',     // Writing, doesn't need frontier reasoning
  // Phases — mechanical work, use cheapest
  'triage':            'claude-sonnet',     // Structured JSON output from a rubric
  'phase_ops':         'gpt4o',            // Digest synthesis only
  'phase_triage':      'claude-sonnet',     // Triage judgment calls
  'phase_pr':          'gpt4o',            // Rarely needs model calls in v2
  // Deep Thought — orchestration + mechanical work → cheap models
  'dt_orchestrator':   'claude-sonnet',     // Coordination only
  'dt_phase_ops':      'gpt4o',            // Pure SQL, scanner reaping
  'dt_phase_codebase': 'claude-sonnet',     // Coordinator, spawns scanners
  // Deep Thought — assessment needs frontier reasoning
  'dt_phase_alerts':   'claude-opus',       // Contextual alert assessment
  'dt_phase_telemetry':'claude-opus',       // APM/log correlation + assessment
  // Deep Thought — scanners are overspent on Opus, Sonnet is sufficient
  'dt_scan_todos':     'claude-sonnet',     // Grep + simple heuristics
  'dt_scan_deps':      'claude-sonnet',     // Manifest parsing + staleness
  'dt_scan_patterns':  'claude-sonnet',     // Grep + false positive filtering
}

// Fallback if no route matches at all
const FALLBACK_MODEL: ProviderName = 'claude-opus'

// ─── Language affinity multipliers ──────────────────────────────────
// >1.0 = this model is stronger for this language

const LANGUAGE_AFFINITIES: Record<ProviderName, Record<string, number>> = {
  'claude-opus':   { go: 1.3, ruby: 1.2, swift: 1.1 },
  'claude-sonnet': { go: 1.2, ruby: 1.1 },
  'gpt5-codex':    { typescript: 1.3, python: 1.2, helm: 1.1 },
  'gpt4o':         { typescript: 1.2, python: 1.1 },
  'gemini-pro':    { terraform: 1.2, python: 1.1 },
}

// ─── Route key helper ───────────────────────────────────────────────

function routeKey(ctx: RoutingContext): string {
  if (ctx.phase) {
    return `${ctx.skill}:${ctx.phase}`
  }
  return ctx.skill
}

// ─── Override row shape ─────────────────────────────────────────────

interface OverrideRow {
  model: string
  reason: string | null
}

// ─── Provider pool resolution ───────────────────────────────────────

function resolveProviderPool(configProviders?: Record<string, ProviderConfig>): Record<ProviderName, ProviderPoolEntry> {
  if (!configProviders) {
    return DEFAULT_PROVIDER_POOL
  }

  const pool: Record<ProviderName, ProviderPoolEntry> = { ...DEFAULT_PROVIDER_POOL }

  for (const [name, config] of Object.entries(configProviders)) {
    if (!config.enabled) {
      delete pool[name]
      continue
    }
    const existing = pool[name]
    pool[name] = {
      litellmModel: config.litellm_model,
      costTier: config.cost_tier ?? existing?.costTier ?? 'medium',
      maxContext: config.max_context ?? existing?.maxContext ?? 128000,
    }
  }

  return pool
}

// ─── Main router ────────────────────────────────────────────────────

interface SelectModelOpts {
  ctx: RoutingContext
  db: Database.Database
  configProviders?: Record<string, ProviderConfig>
}

export function selectModel({ ctx, db, configProviders }: SelectModelOpts): RoutingDecision {
  const pool = resolveProviderPool(configProviders)
  const key = routeKey(ctx)

  // 1. Manual overrides — human says "force X for Y"
  const override = checkOverride(key, ctx.language, db)
  if (override && pool[override.model]) {
    return {
      model: override.model,
      litellmModel: pool[override.model].litellmModel,
      reason: `override: ${override.reason ?? 'manual rule'}`,
    }
  }

  // 2. Learned weights — feedback data picks the best
  const taskType = ctx.taskType ?? key
  const learned = getBestModel(taskType, ctx.language, db)
  if (learned && learned.confidence >= 0.25 && pool[learned.model]) {
    return {
      model: learned.model,
      litellmModel: pool[learned.model].litellmModel,
      reason: `learned: score=${learned.score.toFixed(3)} confidence=${learned.confidence.toFixed(2)} (n=${learned.sampleCount})`,
    }
  }

  // 3. Language affinity — adjust default based on language strengths
  if (ctx.language) {
    const affinityWinner = pickByLanguageAffinity(ctx.language, key, pool)
    if (affinityWinner) {
      return {
        model: affinityWinner,
        litellmModel: pool[affinityWinner].litellmModel,
        reason: `language_affinity: ${ctx.language} (${LANGUAGE_AFFINITIES[affinityWinner]?.[ctx.language]}x)`,
      }
    }
  }

  // 4. Default routing table
  const defaultModel = DEFAULT_ROUTES[key] ?? DEFAULT_ROUTES[ctx.skill] ?? FALLBACK_MODEL
  const model = pool[defaultModel] ? defaultModel : FALLBACK_MODEL

  if (!pool[model]) {
    // All models disabled? Pick the first available one
    const firstAvailable = Object.keys(pool)[0]
    if (!firstAvailable) {
      throw new Error('No models available in provider pool')
    }
    return {
      model: firstAvailable,
      litellmModel: pool[firstAvailable].litellmModel,
      reason: 'fallback: no preferred models available',
    }
  }

  return {
    model,
    litellmModel: pool[model].litellmModel,
    reason: `default: ${key}`,
  }
}

// ─── Override check ─────────────────────────────────────────────────

function checkOverride(key: string, language: string | undefined, db: Database.Database): OverrideRow | null {
  // Try specific match first (task_type + language), then task_type only
  if (language) {
    const specific = db.prepare(
      `SELECT model, reason FROM routing_overrides
       WHERE task_type = ? AND language = ? AND active = 1
       ORDER BY created_at DESC LIMIT 1`
    ).get(key, language) as OverrideRow | undefined

    if (specific) return specific
  }

  const general = db.prepare(
    `SELECT model, reason FROM routing_overrides
     WHERE task_type = ? AND language IS NULL AND active = 1
     ORDER BY created_at DESC LIMIT 1`
  ).get(key) as OverrideRow | undefined

  return general ?? null
}

// ─── Language affinity picker ───────────────────────────────────────
// Returns a model only if a non-default model has a meaningful language
// advantage (multiplier > 1.0) over the default model for this route.

function pickByLanguageAffinity(
  language: string,
  routeKey: string,
  pool: Record<ProviderName, ProviderPoolEntry>,
): ProviderName | null {
  const defaultModel = DEFAULT_ROUTES[routeKey]
  const defaultAffinity = LANGUAGE_AFFINITIES[defaultModel]?.[language] ?? 1.0

  let bestModel: ProviderName | null = null
  let bestAffinity = defaultAffinity

  for (const model of Object.keys(pool)) {
    const affinity = LANGUAGE_AFFINITIES[model]?.[language] ?? 1.0
    if (affinity > bestAffinity) {
      bestAffinity = affinity
      bestModel = model
    }
  }

  // Only override if the winner is different from the default
  if (bestModel && bestModel !== defaultModel) {
    return bestModel
  }

  return null
}

// ─── Cost estimation ────────────────────────────────────────────────
// Estimates the dollar cost of a run based on token counts.
// Uses per-token pricing from config if available, otherwise falls
// back to the cost tier approximation.

interface EstimateCostOpts {
  model: ProviderName
  inputTokens: number
  outputTokens: number
  configProviders?: Record<string, ProviderConfig>
}

export function estimateRunCost({ model, inputTokens, outputTokens, configProviders }: EstimateCostOpts): number {
  // Try explicit per-token pricing from config first
  const configProvider = configProviders?.[model]
  if (configProvider?.cost_per_1k_input != null && configProvider?.cost_per_1k_output != null) {
    return (inputTokens / 1000) * configProvider.cost_per_1k_input
      + (outputTokens / 1000) * configProvider.cost_per_1k_output
  }

  // Fall back to cost tier estimation
  const pool = resolveProviderPool(configProviders)
  const entry = pool[model]
  const tier = entry?.costTier ?? 'medium'
  const rates = COST_TIER_RATES[tier]

  return (inputTokens / 1_000_000) * rates.input
    + (outputTokens / 1_000_000) * rates.output
}

// ─── Provider pool accessor ─────────────────────────────────────────
// Exposes resolved pool info for callers that need context window
// sizes or cost tiers (e.g. context manager, cost dashboards).

export function getProviderPool(configProviders?: Record<string, ProviderConfig>): Record<ProviderName, ProviderPoolEntry> {
  return resolveProviderPool(configProviders)
}

