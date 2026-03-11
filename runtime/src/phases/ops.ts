import type { MarvinConfig } from '../types.js'
import type { StateManager } from '../state.js'
import type { SpawnManager } from '../spawn.js'
import type { PhaseResult } from './types.js'
import { linearCreateComment } from '../tools/linear.js'

// ─── Row types for reaping queries ──────────────────────────────────

interface StaleTicketRow {
  linear_id: string
  identifier: string
  title: string
  last_phase: string | null
}

interface StaleRunRow {
  id: number
  last_phase: string | null
}

interface StaleReviewRunRow extends StaleRunRow {
  ticket_linear_id: string
  pr_number: number
}

interface StaleCiFixRunRow extends StaleRunRow {
  repo: string
  pr_number: number
}

interface StaleAuditRunRow extends StaleRunRow {
  repo: string
  pr_number: number
}

interface StaleDocRunRow extends StaleRunRow {
  ticket_identifier: string
  repo: string
}

// ─── Reaping helpers ────────────────────────────────────────────────

function reapStaleExecutors(opts: {
  config: MarvinConfig
  state: StateManager
  spawn: SpawnManager
  status: string
  label: string
}): number {
  const { config, state, spawn, status, label } = opts
  const db = state.raw()
  const timeoutMinutes = config.limits.stale_executor_minutes

  const stale = db.prepare(`
    SELECT linear_id, identifier, title, last_phase
    FROM tickets
    WHERE status = ?
      AND updated_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' minutes')
  `).all(status, `-${timeoutMinutes}`) as StaleTicketRow[]

  for (const ticket of stale) {
    const phase = ticket.last_phase ?? 'unknown'

    // Mark failed in DB
    db.prepare(`
      UPDATE tickets
      SET status = 'failed',
          error = ? || ' (last phase: ' || COALESCE(last_phase, 'unknown') || ')',
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE linear_id = ? AND status = ?
    `).run(`${label} timed out after ${timeoutMinutes} minutes`, ticket.linear_id, status)

    // Kill process if still running
    spawn.kill(ticket.linear_id)

    // Post timeout comment on Linear
    linearCreateComment({
      issue_id: ticket.linear_id,
      body: `🤖 **Marvin — execution timed out**\n\nThe ${label.toLowerCase()} teammate didn't complete within ${timeoutMinutes} minutes (stuck in **${phase}** phase). This usually means a hung test run or context limit. The ticket will be retried on the next cycle.`,
    }).catch(() => {
      // Best effort — don't fail the phase if comment posting fails
    })

    // Re-queue for retry — but only once (check if already timed out before)
    const alreadyTimedOut = db.prepare(`
      SELECT COUNT(*) as cnt FROM cycle_events
      WHERE message LIKE '%' || ? || '%timed out%'
    `).get(ticket.identifier) as { cnt: number }

    if (alreadyTimedOut.cnt === 0) {
      db.prepare(`
        UPDATE tickets
        SET status = 'triaged',
            error = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE linear_id = ? AND status = 'failed'
      `).run(ticket.linear_id)
    }

    state.logEvent('reaping', `Reaped stale ${label.toLowerCase()} ${ticket.identifier} (stuck in ${phase} phase)`)
  }

  return stale.length
}

function reapStaleReviewRuns(opts: {
  config: MarvinConfig
  state: StateManager
}): number {
  const { config, state } = opts
  const db = state.raw()
  const timeoutMinutes = config.limits.stale_reviewer_minutes

  const stale = db.prepare(`
    SELECT id, ticket_linear_id, pr_number, last_phase
    FROM review_runs
    WHERE status IN ('running', 'queued')
      AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' minutes')
  `).all(`-${timeoutMinutes}`) as StaleReviewRunRow[]

  for (const run of stale) {
    const phase = run.last_phase ?? 'unknown'

    db.prepare(`
      UPDATE review_runs
      SET status = 'failed',
          error = ?,
          finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(`Review teammate timed out after ${timeoutMinutes} minutes (last phase: ${phase})`, run.id)

    // Reset review_status so next cycle can re-detect pending comments
    db.prepare(`
      UPDATE tickets
      SET review_status = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE linear_id = ?
        AND review_status = 'review_in_progress'
    `).run(run.ticket_linear_id)

    state.logEvent('reaping', `Reaped stale reviewer for PR #${run.pr_number} (stuck in ${phase} phase)`)
  }

  return stale.length
}

function reapStaleCiFixRuns(opts: {
  config: MarvinConfig
  state: StateManager
}): number {
  const { config, state } = opts
  const db = state.raw()
  const timeoutMinutes = config.limits.stale_ci_fix_minutes

  const stale = db.prepare(`
    SELECT id, repo, pr_number, last_phase
    FROM ci_fix_runs
    WHERE status IN ('running', 'queued')
      AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' minutes')
  `).all(`-${timeoutMinutes}`) as StaleCiFixRunRow[]

  for (const run of stale) {
    const phase = run.last_phase ?? 'unknown'

    db.prepare(`
      UPDATE ci_fix_runs
      SET status = 'failed',
          error = ?,
          finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(`CI-fix teammate timed out after ${timeoutMinutes} minutes (last phase: ${phase})`, run.id)

    // Reset ci_fix_status so orchestrator re-evaluates next cycle
    db.prepare(`
      UPDATE pull_requests
      SET ci_fix_status = NULL,
          ci_fix_error = ?
      WHERE repo = ? AND pr_number = ?
        AND ci_fix_status = 'fix_in_progress'
    `).run(`CI-fix teammate timed out after ${timeoutMinutes} minutes`, run.repo, run.pr_number)

    state.logEvent('reaping', `Reaped stale CI-fixer for ${run.repo} PR #${run.pr_number} (stuck in ${phase} phase)`)
  }

  return stale.length
}

function reapStaleAuditRuns(opts: {
  config: MarvinConfig
  state: StateManager
}): number {
  const { config, state } = opts
  const db = state.raw()
  const timeoutMinutes = config.limits.stale_auditor_minutes

  const stale = db.prepare(`
    SELECT id, repo, pr_number, last_phase
    FROM audit_runs
    WHERE status IN ('running', 'queued')
      AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' minutes')
  `).all(`-${timeoutMinutes}`) as StaleAuditRunRow[]

  for (const run of stale) {
    const phase = run.last_phase ?? 'unknown'

    db.prepare(`
      UPDATE audit_runs
      SET status = 'failed',
          error = ?,
          finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(`Audit teammate timed out after ${timeoutMinutes} minutes (last phase: ${phase})`, run.id)

    // Reset audit_status so PR gets picked up for audit again
    db.prepare(`
      UPDATE pull_requests
      SET audit_status = NULL
      WHERE repo = ? AND pr_number = ?
        AND audit_status = 'audit_in_progress'
    `).run(run.repo, run.pr_number)

    state.logEvent('reaping', `Reaped stale auditor for ${run.repo} PR #${run.pr_number} (stuck in ${phase} phase)`)
  }

  return stale.length
}

function reapStaleDocRuns(opts: {
  config: MarvinConfig
  state: StateManager
}): number {
  const { config, state } = opts
  const db = state.raw()
  const timeoutMinutes = config.limits.stale_docs_minutes

  const stale = db.prepare(`
    SELECT id, ticket_identifier, repo, last_phase
    FROM doc_runs
    WHERE status IN ('running', 'queued')
      AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' minutes')
  `).all(`-${timeoutMinutes}`) as StaleDocRunRow[]

  for (const run of stale) {
    const phase = run.last_phase ?? 'unknown'

    db.prepare(`
      UPDATE doc_runs
      SET status = 'failed',
          error = ?,
          finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(`Docs teammate timed out (last phase: ${phase})`, run.id)

    state.logEvent('reaping', `Reaped stale docs worker for ${run.ticket_identifier} (stuck in ${phase} phase)`)
  }

  return stale.length
}

// ─── Data trimming ──────────────────────────────────────────────────

function trimOldData(state: StateManager): void {
  const db = state.raw()

  db.prepare(`
    DELETE FROM cycle_events
    WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours')
  `).run()

  db.prepare(`
    DELETE FROM digests
    WHERE sent_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')
  `).run()

  db.prepare(`
    DELETE FROM spawn_queue
    WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours')
  `).run()
}

// ─── Cycle stats ────────────────────────────────────────────────────

function recordCycleStats(state: StateManager): void {
  const db = state.raw()

  // SQLite doesn't support FILTER — use SUM(CASE WHEN...)
  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN triaged_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour') THEN 1 ELSE 0 END) as found,
      SUM(CASE WHEN status = 'triaged' AND triaged_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour') THEN 1 ELSE 0 END) as triaged,
      SUM(CASE WHEN status IN ('executing', 'done') AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour') THEN 1 ELSE 0 END) as executed,
      SUM(CASE WHEN route = 'reassign' AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour') THEN 1 ELSE 0 END) as reassigned,
      SUM(CASE WHEN status = 'deferred' AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour') THEN 1 ELSE 0 END) as deferred,
      SUM(CASE WHEN status = 'failed' AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour') THEN 1 ELSE 0 END) as failed
    FROM tickets
  `).get() as {
    found: number | null
    triaged: number | null
    executed: number | null
    reassigned: number | null
    deferred: number | null
    failed: number | null
  }

  db.prepare(`
    INSERT INTO runs (tickets_found, tickets_triaged, tickets_executed, tickets_reassigned, tickets_deferred, tickets_failed, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  `).run(
    stats.found ?? 0,
    stats.triaged ?? 0,
    stats.executed ?? 0,
    stats.reassigned ?? 0,
    stats.deferred ?? 0,
    stats.failed ?? 0,
  )
}

// ─── Main phase ─────────────────────────────────────────────────────

export async function runPhaseOps(
  config: MarvinConfig,
  state: StateManager,
  spawn: SpawnManager,
): Promise<PhaseResult> {
  // 1. Reap stale workers — both from SpawnManager processes and from DB
  const processReaped = spawn.reap(config.limits.stale_executor_minutes * 60 * 1000)

  if (processReaped.length > 0) {
    state.logEvent('ops', `Reaped ${processReaped.length} stale processes: ${processReaped.join(', ')}`)
  }

  // DB-level reaping with per-type timeouts
  let totalReaped = processReaped.length

  totalReaped += reapStaleExecutors({
    config, state, spawn,
    status: 'executing',
    label: 'Executor',
  })

  totalReaped += reapStaleExecutors({
    config, state, spawn,
    status: 'exploring',
    label: 'Explorer',
  })

  totalReaped += reapStaleReviewRuns({ config, state })
  totalReaped += reapStaleCiFixRuns({ config, state })
  totalReaped += reapStaleAuditRuns({ config, state })
  totalReaped += reapStaleDocRuns({ config, state })

  // 2. Trim old data
  trimOldData(state)

  // 3. Record cycle stats
  recordCycleStats(state)

  // 4. Hourly digest — check if one is due
  const db = state.raw()
  const lastDigest = db.prepare(
    'SELECT sent_at FROM digests ORDER BY sent_at DESC LIMIT 1'
  ).get() as { sent_at: string } | undefined

  let digestSent = false
  if (lastDigest) {
    const lastSentAt = new Date(lastDigest.sent_at)
    const intervalMs = (config.digest_interval_minutes ?? 60) * 60 * 1000
    const now = Date.now()

    if (now - lastSentAt.getTime() >= intervalMs) {
      digestSent = generateDigest(state)
    }
  } else {
    // No digest ever sent — generate one
    digestSent = generateDigest(state)
  }

  const summary = `OPS: reaped=${totalReaped} stats_recorded digest_sent=${digestSent ? 'yes' : 'no'}`
  state.logEvent('ops', summary)

  return {
    summary,
    spawnRequests: [],
  }
}

// ─── Digest generation ──────────────────────────────────────────────

function generateDigest(state: StateManager): boolean {
  const db = state.raw()

  // Gather digest data
  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as cnt
    FROM tickets
    WHERE status NOT IN ('done', 'merged', 'cancelled')
    GROUP BY status
  `).all() as Array<{ status: string; cnt: number }>

  const recentlyDone = db.prepare(`
    SELECT identifier, title, target_repo
    FROM tickets
    WHERE status = 'done'
      AND digest_included_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 10
  `).all() as Array<{ identifier: string; title: string; target_repo: string | null }>

  const openPrs = db.prepare(`
    SELECT repo, pr_number, title, ci_status, review_decision, is_draft, ready_to_merge
    FROM pull_requests
    WHERE state = 'open'
    ORDER BY last_polled_at DESC
  `).all() as Array<{
    repo: string; pr_number: number; title: string
    ci_status: string | null; review_decision: string | null
    is_draft: number; ready_to_merge: number
  }>

  const pendingReviews = db.prepare(`
    SELECT COUNT(*) as cnt FROM review_comments WHERE status = 'pending'
  `).get() as { cnt: number }

  // Build digest content
  const lines: string[] = ['## Marvin digest\n']

  // Status summary
  if (statusCounts.length > 0) {
    lines.push('### Tickets by status')
    for (const { status, cnt } of statusCounts) {
      lines.push(`- **${status}**: ${cnt}`)
    }
    lines.push('')
  }

  // Recently completed
  if (recentlyDone.length > 0) {
    lines.push('### Recently completed')
    for (const t of recentlyDone) {
      lines.push(`- ${t.identifier}: ${t.title} (${t.target_repo ?? 'unknown repo'})`)
    }
    lines.push('')
  }

  // Open PRs
  if (openPrs.length > 0) {
    lines.push('### Open PRs')
    for (const pr of openPrs) {
      const flags = [
        pr.ci_status === 'success' ? '✅ CI' : pr.ci_status === 'failure' ? '❌ CI' : '⏳ CI',
        pr.is_draft ? '📝 draft' : '',
        pr.ready_to_merge ? '🚀 ready' : '',
      ].filter(Boolean).join(' ')
      lines.push(`- ${pr.repo}#${pr.pr_number}: ${pr.title} ${flags}`)
    }
    lines.push('')
  }

  // Pending reviews
  if (pendingReviews.cnt > 0) {
    lines.push(`### Pending review comments: ${pendingReviews.cnt}\n`)
  }

  const content = lines.join('\n')

  // Record digest
  const ticketIds = recentlyDone.map((t) => t.identifier)
  db.prepare(`
    INSERT INTO digests (ticket_ids, content, sent_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  `).run(JSON.stringify(ticketIds), content)

  // Mark completed tickets as digested
  db.prepare(`
    UPDATE tickets
    SET digest_included_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE status = 'done'
      AND (digest_included_at IS NULL OR digest_included_at = '')
  `).run()

  console.log(content)

  return true
}
