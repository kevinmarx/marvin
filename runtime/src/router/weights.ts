import Database from 'better-sqlite3'
import type { LearnedWeight, ProviderName } from '../types.js'

// ─── Score weights ──────────────────────────────────────────────────
// How much each signal contributes to the composite score

const SIGNAL_WEIGHTS = {
  success_rate: 0.25,
  human_rating: 0.30,
  ci_pass_rate: 0.15,
  test_first_pass: 0.10,
  review_efficiency: 0.10,
  token_efficiency: 0.10,
} as const

// Max confidence reached at this many runs
const MAX_CONFIDENCE_RUNS = 20

// ─── Aggregate stats row from DB ────────────────────────────────────

interface ModelStats {
  model: string
  total_runs: number
  successes: number
  avg_human_rating: number | null
  rated_count: number
  ci_passes: number
  ci_total: number
  test_first_passes: number
  test_total: number
  avg_review_rounds: number | null
  review_total: number
  avg_tokens: number | null
}

// ─── Recalculate weights ────────────────────────────────────────────
// Queries model_runs, computes composite scores per model for a given
// task_type (+ optional language), and upserts into routing_weights.

export function recalculateWeights(taskType: string, language: string | undefined, db: Database.Database) {
  const stats = queryModelStats(taskType, language, db)

  if (stats.length === 0) return

  // Find max tokens across models for relative efficiency scoring
  const maxTokens = Math.max(...stats.map(s => s.avg_tokens ?? 0), 1)

  for (const s of stats) {
    const score = computeCompositeScore(s, maxTokens)
    const confidence = Math.min(s.total_runs / MAX_CONFIDENCE_RUNS, 1.0)

    db.prepare(
      `INSERT INTO routing_weights (task_type, language, model, score, confidence, sample_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(task_type, language, model) DO UPDATE SET
         score = excluded.score,
         confidence = excluded.confidence,
         sample_count = excluded.sample_count,
         updated_at = excluded.updated_at`
    ).run(
      taskType,
      language ?? '__any__',
      s.model,
      score,
      confidence,
      s.total_runs,
    )
  }
}

// ─── Get best model ─────────────────────────────────────────────────
// Returns the highest-scoring model for a task_type + language, if any.
// Checks language-specific weights first, then falls back to __any__.

export function getBestModel(taskType: string, language: string | undefined, db: Database.Database): LearnedWeight | null {
  // Try language-specific first
  if (language) {
    const specific = queryBestWeight(taskType, language, db)
    if (specific) return specific
  }

  // Fall back to language-agnostic
  return queryBestWeight(taskType, '__any__', db)
}

// ─── Internal helpers ───────────────────────────────────────────────

function queryBestWeight(taskType: string, language: string, db: Database.Database): LearnedWeight | null {
  const row = db.prepare(
    `SELECT model, score, confidence, sample_count
     FROM routing_weights
     WHERE task_type = ? AND language = ?
     ORDER BY score DESC
     LIMIT 1`
  ).get(taskType, language) as { model: string; score: number; confidence: number; sample_count: number } | undefined

  if (!row) return null

  if (!row.model || typeof row.model !== 'string' || row.model.trim().length === 0) {
    return null
  }

  return {
    model: row.model as ProviderName,
    score: row.score,
    confidence: row.confidence,
    sampleCount: row.sample_count,
  }
}

function queryModelStats(taskType: string, language: string | undefined, db: Database.Database): ModelStats[] {
  const languageClause = language
    ? `AND language = ?`
    : ''

  const params = language
    ? [taskType, language]
    : [taskType]

  const rows = db.prepare(
    `SELECT
      model,
      COUNT(*) as total_runs,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
      AVG(CASE WHEN human_rating IS NOT NULL THEN human_rating END) as avg_human_rating,
      SUM(CASE WHEN human_rating IS NOT NULL THEN 1 ELSE 0 END) as rated_count,
      SUM(CASE WHEN ci_passed IS NOT NULL AND ci_passed = 1 THEN 1 ELSE 0 END) as ci_passes,
      SUM(CASE WHEN ci_passed IS NOT NULL THEN 1 ELSE 0 END) as ci_total,
      SUM(CASE WHEN tests_passed IS NOT NULL AND test_retries = 0 THEN 1 ELSE 0 END) as test_first_passes,
      SUM(CASE WHEN tests_passed IS NOT NULL THEN 1 ELSE 0 END) as test_total,
      AVG(CASE WHEN pr_review_rounds IS NOT NULL AND pr_review_rounds > 0 THEN pr_review_rounds END) as avg_review_rounds,
      SUM(CASE WHEN pr_review_rounds IS NOT NULL AND pr_review_rounds > 0 THEN 1 ELSE 0 END) as review_total,
      AVG(tokens_used) as avg_tokens
    FROM model_runs
    WHERE task_type = ? ${languageClause}
    GROUP BY model`
  ).all(...params) as ModelStats[]

  return rows
}

function computeCompositeScore(s: ModelStats, maxTokens: number): number {
  let score = 0

  // Success rate (0-1)
  const successRate = s.total_runs > 0 ? s.successes / s.total_runs : 0
  score += successRate * SIGNAL_WEIGHTS.success_rate

  // Human rating (1-5 normalized to 0-1)
  // Falls back to success_rate if no human ratings exist
  if (s.rated_count > 0 && s.avg_human_rating != null) {
    const normalizedRating = (s.avg_human_rating - 1) / 4 // 1-5 → 0-1
    score += normalizedRating * SIGNAL_WEIGHTS.human_rating
  } else {
    // No human ratings — use success rate as proxy
    score += successRate * SIGNAL_WEIGHTS.human_rating
  }

  // CI pass rate (0-1)
  if (s.ci_total > 0) {
    score += (s.ci_passes / s.ci_total) * SIGNAL_WEIGHTS.ci_pass_rate
  } else {
    score += successRate * SIGNAL_WEIGHTS.ci_pass_rate
  }

  // Test first-pass rate (0-1) — tests passed without retries
  if (s.test_total > 0) {
    score += (s.test_first_passes / s.test_total) * SIGNAL_WEIGHTS.test_first_pass
  } else {
    score += successRate * SIGNAL_WEIGHTS.test_first_pass
  }

  // Review efficiency (fewer rounds = better)
  // Score: 1.0 for 1 round, decreasing for more rounds
  if (s.review_total > 0 && s.avg_review_rounds != null) {
    const reviewScore = Math.max(0, 1 - (s.avg_review_rounds - 1) / 4) // 1 round = 1.0, 5+ rounds = 0.0
    score += reviewScore * SIGNAL_WEIGHTS.review_efficiency
  } else {
    score += successRate * SIGNAL_WEIGHTS.review_efficiency
  }

  // Token efficiency (lower is better, relative to max)
  if (s.avg_tokens != null && maxTokens > 0) {
    const tokenScore = 1 - (s.avg_tokens / maxTokens)
    score += Math.max(0, tokenScore) * SIGNAL_WEIGHTS.token_efficiency
  }
  // If no token data, this signal contributes 0 (no fallback)

  return score
}
