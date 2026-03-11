import Database from 'better-sqlite3'
import type { RunOutcome, SkillName, ProviderName } from './types.js'
import { randomUUID } from 'node:crypto'

// ─── Row types (DB-specific, not exported from types.ts) ────────────

export interface TicketRow {
  id: number
  linear_id: string
  identifier: string
  title: string
  description: string | null
  priority: number | null
  status: string
  triage_result: string | null
  complexity: number | null
  route: string | null
  target_repo: string | null
  affected_paths: string | null
  pr_url: string | null
  pr_number: number | null
  branch_name: string | null
  worktree_path: string | null
  error: string | null
  assigned_to: string | null
  assigned_to_name: string | null
  last_phase: string | null
  last_phase_at: string | null
  created_at: string
  updated_at: string
  triaged_at: string | null
  executed_at: string | null
}

export interface SpawnQueueRow {
  id: number
  worker_type: string
  worker_name: string
  prompt: string
  status: string
  ticket_linear_id: string | null
  created_at: string
  spawned_at: string | null
}

export interface HeartbeatRow {
  id: number
  cycle_number: number
  current_step: string | null
  last_beat_at: string
  cycle_started_at: string | null
  last_cycle_duration_seconds: number | null
}

// ─── StateManager ───────────────────────────────────────────────────

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

// Whitelists for table/column names used in dynamic SQL
const ALLOWED_TABLES = new Set([
  'tickets',
  'audit_runs',
  'review_runs',
  'ci_fix_runs',
  'doc_runs',
])

const ALLOWED_ID_COLUMNS = new Set([
  'linear_id',
  'id',
  'ticket_linear_id',
])

const ALLOWED_TICKET_EXTRA_COLUMNS = new Set([
  'error',
  'pr_url',
  'pr_number',
  'branch_name',
  'worktree_path',
  'triage_result',
  'complexity',
  'route',
  'target_repo',
  'affected_paths',
  'assigned_to',
  'assigned_to_name',
  'last_phase',
  'last_phase_at',
  'triaged_at',
  'executed_at',
])

const ALLOWED_RUN_EXTRA_COLUMNS = new Set([
  'error',
  'findings_json',
  'finished_at',
  'pr_url',
  'pr_number',
  'branch_name',
])

export class StateManager {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 30000')
  }

  // ── Heartbeat ──────────────────────────────────────────────────

  updateHeartbeat(step: string): void {
    this.db.prepare(`
      UPDATE heartbeat
      SET current_step = ?, last_beat_at = ${NOW_SQL}
      WHERE id = 1
    `).run(step)
  }

  getHeartbeat(): HeartbeatRow | undefined {
    return this.db.prepare('SELECT * FROM heartbeat WHERE id = 1').get() as HeartbeatRow | undefined
  }

  incrementCycle(): void {
    this.db.prepare(`
      UPDATE heartbeat
      SET cycle_number = cycle_number + 1,
          cycle_started_at = ${NOW_SQL},
          last_beat_at = ${NOW_SQL}
      WHERE id = 1
    `).run()
  }

  recordCycleDuration(seconds: number): void {
    this.db.prepare(`
      UPDATE heartbeat
      SET last_beat_at = ${NOW_SQL},
          last_cycle_duration_seconds = ?
      WHERE id = 1
    `).run(seconds)
  }

  // ── Cycle events ───────────────────────────────────────────────

  logEvent(step: string, message: string): void {
    const heartbeat = this.getHeartbeat()
    const cycleNumber = heartbeat?.cycle_number ?? 0
    this.db.prepare(`
      INSERT INTO cycle_events (cycle_number, step, message, created_at)
      VALUES (?, ?, ?, ${NOW_SQL})
    `).run(cycleNumber, step, message)
  }

  // ── Tickets ────────────────────────────────────────────────────

  getTicket(linearId: string): TicketRow | undefined {
    return this.db.prepare(
      'SELECT * FROM tickets WHERE linear_id = ?'
    ).get(linearId) as TicketRow | undefined
  }

  updateTicketStatus(linearId: string, status: string, extra?: Record<string, unknown>): void {
    if (extra && Object.keys(extra).length > 0) {
      const setClauses = [`status = ?`, `updated_at = ${NOW_SQL}`]
      const values: unknown[] = [status]
      for (const [key, value] of Object.entries(extra)) {
        if (!ALLOWED_TICKET_EXTRA_COLUMNS.has(key)) {
          throw new Error(`Invalid ticket column: ${key}`)
        }
        setClauses.push(`${key} = ?`)
        values.push(value)
      }
      values.push(linearId)
      this.db.prepare(`
        UPDATE tickets SET ${setClauses.join(', ')} WHERE linear_id = ?
      `).run(...values)
    } else {
      this.db.prepare(`
        UPDATE tickets SET status = ?, updated_at = ${NOW_SQL} WHERE linear_id = ?
      `).run(status, linearId)
    }
  }

  updateTicketPhase(linearId: string, phase: string): void {
    this.db.prepare(`
      UPDATE tickets
      SET last_phase = ?, last_phase_at = ${NOW_SQL}, updated_at = ${NOW_SQL}
      WHERE linear_id = ?
    `).run(phase, linearId)
  }

  // ── Worker runs (generic) ─────────────────────────────────────

  updateRunPhase(table: string, idColumn: string, idValue: string | number, phase: string): void {
    if (!ALLOWED_TABLES.has(table)) throw new Error(`Invalid table: ${table}`)
    if (!ALLOWED_ID_COLUMNS.has(idColumn)) throw new Error(`Invalid column: ${idColumn}`)
    this.db.prepare(`
      UPDATE ${table}
      SET last_phase = ?, last_phase_at = ${NOW_SQL}
      WHERE ${idColumn} = ?
    `).run(phase, idValue)
  }

  updateRunStatus(
    table: string,
    idColumn: string,
    idValue: string | number,
    status: string,
    extra?: Record<string, unknown>
  ): void {
    if (!ALLOWED_TABLES.has(table)) throw new Error(`Invalid table: ${table}`)
    if (!ALLOWED_ID_COLUMNS.has(idColumn)) throw new Error(`Invalid column: ${idColumn}`)

    const setClauses = [`status = ?`]
    const values: unknown[] = [status]

    if (status === 'completed' || status === 'failed') {
      setClauses.push(`finished_at = ${NOW_SQL}`)
    }

    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (!ALLOWED_RUN_EXTRA_COLUMNS.has(key)) {
          throw new Error(`Invalid run column: ${key}`)
        }
        setClauses.push(`${key} = ?`)
        values.push(value)
      }
    }

    values.push(idValue)
    this.db.prepare(`
      UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${idColumn} = ?
    `).run(...values)
  }

  // ── Spawn queue ────────────────────────────────────────────────

  queueSpawn(opts: {
    workerType: string
    workerName: string
    prompt: string
    ticketLinearId?: string
  }): void {
    this.db.prepare(`
      INSERT INTO spawn_queue (worker_type, worker_name, prompt, ticket_linear_id, created_at)
      VALUES (?, ?, ?, ?, ${NOW_SQL})
    `).run(opts.workerType, opts.workerName, opts.prompt, opts.ticketLinearId ?? null)
  }

  getPendingSpawns(): SpawnQueueRow[] {
    return this.db.prepare(
      "SELECT * FROM spawn_queue WHERE status = 'pending' ORDER BY created_at ASC"
    ).all() as SpawnQueueRow[]
  }

  markSpawnStatus(id: number, status: 'spawned' | 'failed' | 'cancelled'): void {
    const spawnedAt = status === 'spawned' ? `, spawned_at = ${NOW_SQL}` : ''
    this.db.prepare(`
      UPDATE spawn_queue SET status = ?${spawnedAt} WHERE id = ?
    `).run(status, id)
  }

  // ── Concurrency ────────────────────────────────────────────────

  countRunningWorkers(): number {
    // Count executing/exploring tickets
    const ticketCount = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM tickets WHERE status IN ('executing', 'exploring')"
    ).get() as { cnt: number }).cnt

    // Count running audit_runs
    const auditCount = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM audit_runs WHERE status = 'running'"
    ).get() as { cnt: number }).cnt

    // Count running review_runs
    const reviewCount = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM review_runs WHERE status = 'running'"
    ).get() as { cnt: number }).cnt

    // Count running ci_fix_runs
    const ciFixCount = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM ci_fix_runs WHERE status = 'running'"
    ).get() as { cnt: number }).cnt

    // Count running doc_runs
    const docCount = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM doc_runs WHERE status = 'running'"
    ).get() as { cnt: number }).cnt

    return ticketCount + auditCount + reviewCount + ciFixCount + docCount
  }

  // ── Model feedback ─────────────────────────────────────────────

  insertModelRun(run: Partial<RunOutcome>): string {
    const id = run.id ?? randomUUID()
    this.db.prepare(`
      INSERT INTO model_runs (
        id, skill, phase, model, task_type, language, complexity,
        ticket_id, ticket_identifier,
        success, tests_passed, test_retries, ci_passed,
        pr_review_rounds, tokens_used, duration_seconds, tool_call_count,
        created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ${NOW_SQL}
      )
    `).run(
      id,
      run.skill ?? null,
      run.phase ?? null,
      run.model ?? null,
      run.taskType ?? null,
      run.language ?? null,
      run.complexity ?? null,
      run.ticketId ?? null,
      run.ticketIdentifier ?? null,
      run.success !== undefined ? (run.success ? 1 : 0) : 0,
      run.testsPassed !== undefined ? (run.testsPassed ? 1 : 0) : null,
      run.testRetries ?? 0,
      run.ciPassed !== undefined ? (run.ciPassed ? 1 : 0) : null,
      run.prReviewRounds ?? 0,
      run.tokensUsed ?? 0,
      run.durationSeconds ?? 0,
      run.toolCallCount ?? 0,
    )
    return id
  }

  updateModelRun(id: string, fields: Partial<RunOutcome>): void {
    const setClauses: string[] = []
    const values: unknown[] = []

    const fieldMap: Record<string, string> = {
      success: 'success',
      testsPassed: 'tests_passed',
      testRetries: 'test_retries',
      ciPassed: 'ci_passed',
      prReviewRounds: 'pr_review_rounds',
      tokensUsed: 'tokens_used',
      durationSeconds: 'duration_seconds',
      toolCallCount: 'tool_call_count',
      humanRating: 'human_rating',
      humanNotes: 'human_notes',
      codeQuality: 'code_quality',
      correctness: 'correctness',
      efficiency: 'efficiency',
      testQuality: 'test_quality',
      ratedAt: 'rated_at',
      skill: 'skill',
      phase: 'phase',
      model: 'model',
      taskType: 'task_type',
      language: 'language',
      complexity: 'complexity',
    }

    for (const [tsKey, dbCol] of Object.entries(fieldMap)) {
      const value = fields[tsKey as keyof RunOutcome]
      if (value !== undefined) {
        setClauses.push(`${dbCol} = ?`)
        if (typeof value === 'boolean') {
          values.push(value ? 1 : 0)
        } else {
          values.push(value)
        }
      }
    }

    if (setClauses.length === 0) return

    values.push(id)
    this.db.prepare(`UPDATE model_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
  }

  getModelRun(id: string): RunOutcome | undefined {
    const row = this.db.prepare('SELECT * FROM model_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return undefined
    return rowToRunOutcome(row)
  }

  getUnratedRuns(limit = 20): RunOutcome[] {
    const rows = this.db.prepare(
      'SELECT * FROM model_runs WHERE human_rating IS NULL ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as Record<string, unknown>[]
    return rows.map(rowToRunOutcome)
  }

  // ── Raw escape hatch ───────────────────────────────────────────

  raw(): Database.Database {
    return this.db
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function rowToRunOutcome(row: Record<string, unknown>): RunOutcome {
  return {
    id: row.id as string,
    skill: row.skill as SkillName,
    phase: row.phase as string | undefined,
    model: row.model as ProviderName,
    taskType: row.task_type as string,
    language: row.language as string | undefined,
    complexity: row.complexity as number | undefined,
    ticketId: row.ticket_id as string | undefined,
    ticketIdentifier: row.ticket_identifier as string | undefined,
    success: row.success === 1,
    testsPassed: row.tests_passed === null ? undefined : row.tests_passed === 1,
    testRetries: row.test_retries as number,
    ciPassed: row.ci_passed === null ? undefined : row.ci_passed === 1,
    prReviewRounds: row.pr_review_rounds as number,
    tokensUsed: row.tokens_used as number,
    durationSeconds: row.duration_seconds as number,
    toolCallCount: row.tool_call_count as number,
    humanRating: row.human_rating as number | undefined,
    humanNotes: row.human_notes as string | undefined,
    codeQuality: row.code_quality as number | undefined,
    correctness: row.correctness as number | undefined,
    efficiency: row.efficiency as number | undefined,
    testQuality: row.test_quality as number | undefined,
    createdAt: row.created_at as string,
    ratedAt: row.rated_at as string | undefined,
  }
}
