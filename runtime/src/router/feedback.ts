import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import type { SkillName, ProviderName, RoutingContext, TokenUsage } from '../types.js'

// ─── Run tracker ────────────────────────────────────────────────────

interface StartRunOpts {
  skill: SkillName
  model: ProviderName
  routingContext: RoutingContext
  ticketId?: string
  ticketIdentifier?: string
  db: Database.Database
}

export interface RunTracker {
  runId: string
  trackTokens: (usage: TokenUsage) => void
  trackToolCall: () => void
  complete: (opts: CompleteOpts) => void
  fail: (error: string) => void
}

interface CompleteOpts {
  success: boolean
  testsPassed?: boolean
  testRetries?: number
}

export function startRun({ skill, model, routingContext, ticketId, ticketIdentifier, db }: StartRunOpts): RunTracker {
  const runId = randomUUID()
  const startTime = Date.now()
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let toolCallCount = 0

  const taskType = routingContext.taskType ?? buildTaskType(routingContext)

  // Insert the initial run record
  db.prepare(
    `INSERT INTO model_runs (
      id, skill, phase, model, task_type, language, complexity,
      ticket_id, ticket_identifier, success, test_retries, pr_review_rounds,
      tokens_used, duration_seconds, tool_call_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
  ).run(
    runId,
    skill,
    routingContext.phase ?? null,
    model,
    taskType,
    routingContext.language ?? null,
    routingContext.complexity ?? null,
    ticketId ?? null,
    ticketIdentifier ?? null,
  )

  return {
    runId,

    trackTokens(usage: TokenUsage) {
      totalInputTokens += usage.input_tokens
      totalOutputTokens += usage.output_tokens
    },

    trackToolCall() {
      toolCallCount++
    },

    complete({ success, testsPassed, testRetries }: CompleteOpts) {
      const durationSeconds = Math.round((Date.now() - startTime) / 1000)
      const tokensUsed = totalInputTokens + totalOutputTokens

      db.prepare(
        `UPDATE model_runs SET
          success = ?,
          tests_passed = ?,
          test_retries = ?,
          tokens_used = ?,
          duration_seconds = ?,
          tool_call_count = ?,
          input_tokens = ?,
          output_tokens = ?
        WHERE id = ?`
      ).run(
        success ? 1 : 0,
        testsPassed != null ? (testsPassed ? 1 : 0) : null,
        testRetries ?? 0,
        tokensUsed,
        durationSeconds,
        toolCallCount,
        totalInputTokens,
        totalOutputTokens,
        runId,
      )
    },

    fail(error: string) {
      const durationSeconds = Math.round((Date.now() - startTime) / 1000)
      const tokensUsed = totalInputTokens + totalOutputTokens

      db.prepare(
        `UPDATE model_runs SET
          success = 0,
          error_message = ?,
          tokens_used = ?,
          duration_seconds = ?,
          tool_call_count = ?,
          input_tokens = ?,
          output_tokens = ?
        WHERE id = ?`
      ).run(
        error.slice(0, 2000),
        tokensUsed,
        durationSeconds,
        toolCallCount,
        totalInputTokens,
        totalOutputTokens,
        runId,
      )
    },
  }
}

// ─── Post-run signal updates ────────────────────────────────────────

export function updateCIResult(runId: string, ciPassed: boolean, db: Database.Database) {
  db.prepare(
    `UPDATE model_runs SET ci_passed = ? WHERE id = ?`
  ).run(ciPassed ? 1 : 0, runId)
}

export function updateReviewRounds(runId: string, rounds: number, db: Database.Database) {
  db.prepare(
    `UPDATE model_runs SET pr_review_rounds = ? WHERE id = ?`
  ).run(rounds, runId)
}

interface RateRunOpts {
  humanRating: number
  humanNotes?: string
  codeQuality?: number
  correctness?: number
  efficiency?: number
  testQuality?: number
}

export function rateRun(runId: string, rating: RateRunOpts, db: Database.Database) {
  db.prepare(
    `UPDATE model_runs SET
      human_rating = ?,
      human_notes = ?,
      code_quality = ?,
      correctness = ?,
      efficiency = ?,
      test_quality = ?,
      rated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ?`
  ).run(
    rating.humanRating,
    rating.humanNotes ?? null,
    rating.codeQuality ?? null,
    rating.correctness ?? null,
    rating.efficiency ?? null,
    rating.testQuality ?? null,
    runId,
  )
}

// ─── Task type builder ──────────────────────────────────────────────
// Builds a task_type string from routing context when not explicitly provided

function buildTaskType(ctx: RoutingContext): string {
  const parts: string[] = []

  if (ctx.language) {
    parts.push(ctx.language)
  }

  if (ctx.phase) {
    parts.push(`${ctx.skill}:${ctx.phase}`)
  } else {
    parts.push(ctx.skill)
  }

  return parts.join('_') || ctx.skill
}
