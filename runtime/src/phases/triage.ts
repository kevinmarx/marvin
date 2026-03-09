import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { MarvinConfig } from '../types.js'
import type { StateManager } from '../state.js'
import type { PhaseResult, SpawnRequest } from './types.js'
import { linearListIssues, linearGetIssue, linearCreateComment } from '../tools/linear.js'
import { bashExec } from '../tools/bash.js'
import { chat } from '../router/client.js'
import { selectModel } from '../router/router.js'

// ─── Load triage prompt at module load time ─────────────────────────

function findMarvinRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname)
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'config')) && fs.existsSync(path.join(dir, 'skills'))) {
      return dir
    }
    dir = path.dirname(dir)
  }
  throw new Error('Could not locate marvin repo root')
}

const TRIAGE_PROMPT_TEMPLATE = fs.readFileSync(
  path.join(findMarvinRoot(), 'prompts', 'triage.md'),
  'utf-8',
)

// ─── Row types ──────────────────────────────────────────────────────

interface ReassessRow {
  id: number
  linear_id: string
  identifier: string
}

interface LinearIssueNode {
  id: string
  identifier: string
  title: string
  state: { name: string; type: string }
  assignee: { name: string; email: string } | null
  labels: { nodes: Array<{ name: string }> }
  priority: number
  createdAt: string
  updatedAt: string
}

interface TriageResult {
  complexity: number
  target_repo: string
  affected_paths: string[]
  route: 'execute' | 'reassign' | 'defer'
  route_reason: string
  confidence: number
  risks: string[]
  implementation_hint: string
  recommended_assignee: string | null
  clarifying_questions?: string[]
  defer_ambiguity_type?: string
}

interface TriagedTicketRow {
  linear_id: string
  identifier: string
  title: string
  description: string | null
  target_repo: string | null
  complexity: number | null
  route: string | null
  affected_paths: string | null
  triage_result: string | null
}

interface DeferredTicketRow {
  linear_id: string
  identifier: string
  title: string
  description: string | null
  triage_result: string | null
  defer_status: string
  defer_followup_count: number
  defer_last_checked_at: string | null
  defer_last_followup_at: string | null
  defer_description_hash: string | null
}

// ─── Helpers ────────────────────────────────────────────────────────

function hashDescription(desc: string): string {
  return createHash('sha256').update(desc).digest('hex')
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

function extractTicketNumber(identifier: string): string {
  // "GM-1234" → "1234"
  const match = identifier.match(/\d+$/)
  return match?.[0] ?? identifier
}

function countAvailableSlots(state: StateManager, maxWorkers: number): number {
  const db = state.raw()
  const running = (db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tickets WHERE status IN ('executing', 'exploring')) +
      (SELECT COUNT(*) FROM audit_runs WHERE status IN ('running', 'queued')) +
      (SELECT COUNT(*) FROM review_runs WHERE status IN ('running', 'queued')) +
      (SELECT COUNT(*) FROM ci_fix_runs WHERE status IN ('running', 'queued')) +
      (SELECT COUNT(*) FROM doc_runs WHERE status IN ('running', 'queued'))
    AS running_workers
  `).get() as { running_workers: number }).running_workers

  return Math.max(0, maxWorkers - running)
}

// ─── Triage model call ──────────────────────────────────────────────

async function triageTicket(opts: {
  title: string
  description: string | null
  priority: number | null
  estimate?: number | null
  config: MarvinConfig
  state: StateManager
  previousTriageContext?: string
  newComments?: string
}): Promise<TriageResult> {
  const { title, description, priority, estimate, config, state } = opts

  // Build repo list for the prompt
  const repoList = Object.keys(config.repos)
    .map((name) => `- ${name}: ${config.repos[name]}`)
    .join('\n')

  // Build the triage prompt
  const promptParts = [
    'Read the ticket and produce a triage assessment as JSON.',
    '',
    TRIAGE_PROMPT_TEMPLATE,
    '',
    'Ticket:',
    `- Title: ${title}`,
    `- Description: ${description ?? '(none)'}`,
    `- Priority: ${priority ?? 'unset'}`,
    `- Estimate: ${estimate ?? 'unset'}`,
    '',
    `Available repos:\n${repoList}`,
    `Complexity threshold: ${config.complexity_threshold}`,
  ]

  // Add re-triage context if present
  if (opts.previousTriageContext) {
    promptParts.push('')
    promptParts.push(`previous_triage_context: ${opts.previousTriageContext}`)
  }
  if (opts.newComments) {
    promptParts.push(`new_comments: ${opts.newComments}`)
  }

  const prompt = promptParts.join('\n')

  // Select model via router
  const routing = selectModel({
    ctx: { skill: 'triage' },
    db: state.raw(),
    configProviders: config.routing?.providers,
  })

  const response = await chat({
    model: routing.litellmModel,
    messages: [
      { role: 'user', content: prompt },
    ],
    temperature: 0,
  })

  if (!response.content) {
    throw new Error('Triage model returned empty response')
  }

  // Parse JSON — strip markdown fences if present
  let jsonStr = response.content.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  try {
    return JSON.parse(jsonStr) as TriageResult
  } catch {
    throw new Error(`Failed to parse triage JSON: ${jsonStr.slice(0, 200)}`)
  }
}

// ─── Worktree setup ─────────────────────────────────────────────────

function setupWorktree(opts: {
  config: MarvinConfig
  identifier: string
  targetRepo: string
}): { branchName: string; worktreePath: string } | null {
  const { config, identifier } = opts
  const repoPath = config.repos[opts.targetRepo]
  if (!repoPath) return null

  const slug = identifier.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const branchName = `${config.branch_prefix}/${slug}`
  const worktreePath = path.join(config.worktree_root, identifier)

  // Fetch latest main
  bashExec({ command: 'git fetch origin main', cwd: repoPath, timeout: 30_000 })

  if (fs.existsSync(worktreePath)) {
    // Worktree already exists — try to checkout the branch
    bashExec({ command: `git checkout "${branchName}" 2>/dev/null || true`, cwd: worktreePath, timeout: 10_000 })
  } else {
    // Create new worktree
    const result = bashExec({
      command: `git worktree add "${worktreePath}" -b "${branchName}" origin/main`,
      cwd: repoPath,
      timeout: 30_000,
    })

    if (result.error) {
      return null
    }

    // Unset upstream tracking to prevent accidental push to main
    bashExec({
      command: `git branch --unset-upstream "${branchName}" 2>/dev/null || true`,
      cwd: worktreePath,
      timeout: 5_000,
    })
  }

  return { branchName, worktreePath }
}

// ─── Route a ticket ─────────────────────────────────────────────────

function routeTicket(opts: {
  config: MarvinConfig
  state: StateManager
  linearId: string
  identifier: string
  triage: TriageResult
  slots: number
  spawnRequests: SpawnRequest[]
}): { slotUsed: boolean; routed: 'execute' | 'explore' | 'reassign' | 'defer' | 'skipped' } {
  const { config, state, linearId, identifier, triage, slots, spawnRequests } = opts
  const db = state.raw()

  // Determine effective route — override to explore if complexity > threshold
  let effectiveRoute: 'execute' | 'explore' | 'reassign' | 'defer' = triage.route
  if (effectiveRoute === 'execute' && triage.complexity > config.complexity_threshold) {
    effectiveRoute = 'explore'
    db.prepare(`
      UPDATE tickets SET route = 'explore' WHERE linear_id = ?
    `).run(linearId)
  }

  if (effectiveRoute === 'execute' || effectiveRoute === 'explore') {
    // Check concurrency
    if (slots <= 0) {
      state.logEvent('triage', `Concurrency limit: leaving ${identifier} as triaged`)
      return { slotUsed: false, routed: 'skipped' }
    }

    // Set up worktree
    const targetRepo = triage.target_repo
    const worktree = setupWorktree({ config, identifier, targetRepo })

    if (worktree) {
      // Store worktree info (do NOT set status to executing/exploring)
      db.prepare(`
        UPDATE tickets
        SET branch_name = ?, worktree_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE linear_id = ?
      `).run(worktree.branchName, worktree.worktreePath, linearId)

      // Queue worker in spawn_queue
      const workerType = effectiveRoute === 'execute' ? 'executor' : 'explorer'
      const number = extractTicketNumber(identifier)
      const workerName = effectiveRoute === 'execute' ? `exec-${number}` : `explore-${number}`

      state.queueSpawn({
        workerType,
        workerName,
        ticketLinearId: linearId,
        prompt: JSON.stringify({
          linear_id: linearId,
          identifier,
          target_repo: targetRepo,
          repo_path: config.repos[targetRepo],
          worktree_path: worktree.worktreePath,
          branch_name: worktree.branchName,
        }),
      })

      state.logEvent('triage', `Queued ${workerType} for ${identifier} (complexity=${triage.complexity}, repo=${targetRepo})`)
    } else {
      state.logEvent('triage', `Failed to setup worktree for ${identifier}`)
    }

    return { slotUsed: true, routed: effectiveRoute as 'execute' | 'explore' }
  }

  if (effectiveRoute === 'reassign') {
    // Mark as reassigned in DB
    db.prepare(`
      UPDATE tickets
      SET status = 'reassigned',
          assigned_to_name = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE linear_id = ?
    `).run(triage.recommended_assignee, linearId)

    state.logEvent('triage', `Reassigned ${identifier} to ${triage.recommended_assignee ?? 'unknown'}`)
    return { slotUsed: false, routed: 'reassign' }
  }

  if (effectiveRoute === 'defer') {
    // Will be handled by deferTicket
    return { slotUsed: false, routed: 'defer' }
  }

  return { slotUsed: false, routed: 'skipped' }
}

// ─── Defer a ticket ─────────────────────────────────────────────────

async function deferTicket(opts: {
  state: StateManager
  linearId: string
  identifier: string
  description: string | null
  triage: TriageResult
}): Promise<boolean> {
  const { state, linearId, identifier, description, triage } = opts
  const db = state.raw()

  const questions = triage.clarifying_questions ?? []
  if (questions.length === 0) return false

  const commentBody = [
    '🤖 **Marvin — needs clarification**',
    '',
    "I'd like to pick this up but need a bit more context:",
    ...questions.map((q) => `- ${q}`),
    '',
    "Once there's more info here, I'll automatically re-evaluate.",
  ].join('\n')

  // Post comment to Linear
  const commentResult = await linearCreateComment({
    issue_id: linearId,
    body: commentBody,
  })

  if (commentResult.error) {
    state.logEvent('triage', `Failed to post defer comment for ${identifier}: ${commentResult.error}`)
    return false
  }

  // Extract comment ID from response
  let commentId: string | null = null
  try {
    const parsed = JSON.parse(commentResult.output)
    commentId = parsed.id ?? null
  } catch (err) {
    // If we can't parse, still mark as deferred without comment_id
    state.logEvent('triage', `Failed to parse defer comment response for ${identifier}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Hash the description
  const descHash = hashDescription(description ?? '')

  // Update DB
  db.prepare(`
    UPDATE tickets SET
      status = 'deferred',
      defer_status = 'awaiting_response',
      defer_comment_id = ?,
      defer_followup_count = 1,
      defer_last_followup_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      defer_last_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      defer_description_hash = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE linear_id = ?
  `).run(commentId, descHash, linearId)

  state.logEvent('triage', `Deferred ${identifier}: ${triage.route_reason}`)
  return true
}

// ─── Poll deferred tickets ──────────────────────────────────────────

async function pollDeferredTickets(opts: {
  config: MarvinConfig
  state: StateManager
  slots: number
  spawnRequests: SpawnRequest[]
}): Promise<{ retriaged: number }> {
  const { config, state, spawnRequests } = opts
  let { slots } = opts
  const db = state.raw()

  const deferred = db.prepare(`
    SELECT linear_id, identifier, title, description, triage_result,
           defer_status, defer_followup_count, defer_last_checked_at,
           defer_last_followup_at, defer_description_hash
    FROM tickets
    WHERE status = 'deferred'
      AND defer_status IN ('awaiting_response', 'exhausted')
      AND (
        (defer_status = 'awaiting_response' AND (defer_last_checked_at IS NULL OR defer_last_checked_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')))
        OR
        (defer_status = 'exhausted' AND (defer_last_checked_at IS NULL OR defer_last_checked_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours')))
      )
  `).all() as DeferredTicketRow[]

  let retriaged = 0

  for (const ticket of deferred) {
    // Fetch current state from Linear
    const issueResult = await linearGetIssue(ticket.linear_id)
    if (issueResult.error) continue

    let issue: { description?: string; state?: { type: string }; assignee?: { name: string } | null; comments?: { nodes: Array<{ body: string; user: { name: string }; createdAt: string }> } }
    try {
      issue = JSON.parse(issueResult.output)
    } catch (err) {
      state.logEvent('triage', `Failed to parse response: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    // Pre-flight: if cancelled or done in Linear
    if (issue.state?.type === 'completed' || issue.state?.type === 'canceled') {
      db.prepare(`
        UPDATE tickets SET status = ?, defer_status = NULL, defer_comment_id = NULL,
          defer_followup_count = 0, defer_last_checked_at = NULL, defer_last_followup_at = NULL,
          defer_description_hash = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE linear_id = ?
      `).run(issue.state.type === 'completed' ? 'done' : 'cancelled', ticket.linear_id)
      continue
    }

    // Detect description changes
    const currentDesc = issue.description ?? ''
    const currentHash = hashDescription(currentDesc)
    const descriptionChanged = currentHash !== ticket.defer_description_hash

    // Detect new human comments (non-Marvin comments after last followup)
    const lastFollowup = ticket.defer_last_followup_at ?? '1970-01-01T00:00:00Z'
    const humanComments = (issue.comments?.nodes ?? []).filter((c) => {
      return !c.body.startsWith('🤖') && c.createdAt > lastFollowup
    })
    const hasNewInfo = descriptionChanged || humanComments.length > 0

    if (!hasNewInfo) {
      // No new info — check if nudge is due
      const followupCount = ticket.defer_followup_count ?? 0
      const daysSinceLastFollowup = ticket.defer_last_followup_at
        ? (Date.now() - new Date(ticket.defer_last_followup_at).getTime()) / (1000 * 60 * 60 * 24)
        : Infinity

      if (ticket.defer_status === 'awaiting_response' && daysSinceLastFollowup >= 7 && followupCount < 3) {
        // Post nudge
        const nudgeResult = await linearCreateComment({
          issue_id: ticket.linear_id,
          body: "🤖 **Marvin — gentle nudge**\n\nJust checking in — this ticket is still waiting for clarification. The questions above are still open. Let me know if I should approach this differently or if the requirements have changed.",
        })

        if (!nudgeResult.error) {
          db.prepare(`
            UPDATE tickets SET
              defer_followup_count = defer_followup_count + 1,
              defer_last_followup_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              defer_last_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE linear_id = ?
          `).run(ticket.linear_id)
        }
      } else {
        // Just update last checked
        db.prepare(`
          UPDATE tickets SET
            defer_last_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE linear_id = ?
        `).run(ticket.linear_id)
      }

      continue
    }

    // New info found — re-triage
    const newCommentText = humanComments.map((c) => `${c.user.name}: ${c.body}`).join('\n\n')

    // If exhausted and new comments arrive, reset count to 2 (gives one more round)
    if (ticket.defer_status === 'exhausted') {
      db.prepare(`
        UPDATE tickets SET defer_followup_count = 2, defer_status = 'awaiting_response'
        WHERE linear_id = ?
      `).run(ticket.linear_id)
    }

    try {
      const reTriage = await triageTicket({
        title: ticket.title,
        description: currentDesc,
        priority: null,
        config,
        state,
        previousTriageContext: ticket.triage_result ?? undefined,
        newComments: newCommentText || undefined,
      })

      // Update triage result
      db.prepare(`
        UPDATE tickets SET
          triage_result = ?,
          complexity = ?,
          route = ?,
          target_repo = ?,
          affected_paths = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE linear_id = ?
      `).run(
        JSON.stringify(reTriage),
        reTriage.complexity,
        reTriage.route,
        reTriage.target_repo,
        JSON.stringify(reTriage.affected_paths),
        ticket.linear_id,
      )

      if (reTriage.route === 'execute' || reTriage.route === 'reassign') {
        // Clear defer fields, set to triaged
        db.prepare(`
          UPDATE tickets SET
            status = 'triaged',
            defer_status = NULL, defer_comment_id = NULL,
            defer_followup_count = 0, defer_last_checked_at = NULL,
            defer_last_followup_at = NULL, defer_description_hash = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE linear_id = ?
        `).run(ticket.linear_id)

        // Route it
        const result = routeTicket({
          config, state,
          linearId: ticket.linear_id,
          identifier: ticket.identifier,
          triage: reTriage,
          slots,
          spawnRequests,
        })
        if (result.slotUsed) slots--
        retriaged++
      } else if (reTriage.route === 'defer') {
        const followupCount = (db.prepare(
          'SELECT defer_followup_count FROM tickets WHERE linear_id = ?'
        ).get(ticket.linear_id) as { defer_followup_count: number }).defer_followup_count

        if (followupCount >= 3) {
          // Exhausted — post final comment
          await linearCreateComment({
            issue_id: ticket.linear_id,
            body: "🤖 **Marvin — deferring to manual triage**\n\nI've asked for clarification multiple times but still can't determine the right approach. This ticket needs manual triage by a human.",
          })

          db.prepare(`
            UPDATE tickets SET
              defer_status = 'exhausted',
              defer_last_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE linear_id = ?
          `).run(ticket.linear_id)
        } else {
          // Post new questions
          await deferTicket({
            state,
            linearId: ticket.linear_id,
            identifier: ticket.identifier,
            description: currentDesc,
            triage: reTriage,
          })
        }
      }
    } catch (err) {
      state.logEvent('triage', `Re-triage failed for ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { retriaged }
}

// ─── Main phase ─────────────────────────────────────────────────────

export async function runPhaseTriage(
  config: MarvinConfig,
  state: StateManager,
): Promise<PhaseResult> {
  const db = state.raw()
  const spawnRequests: SpawnRequest[] = []
  const maxWorkers = config.limits.max_concurrent_workers ?? 8

  // Validate assignee is configured
  const assignee = config.linear_user ?? config.assignee
  if (!assignee) {
    state.logEvent('triage', 'ERROR: No assignee configured (linear_user or assignee required)')
    return { summary: 'Triage: failed — no assignee configured', spawnRequests: [] }
  }

  // Counters
  let found = 0
  let triaged = 0
  let executed = 0
  let explored = 0
  let reassigned = 0
  let deferred = 0
  let concurrencyDeferred = 0

  // ── 0. Process reassess requests ──────────────────────────────
  const reassessRequests = db.prepare(`
    SELECT id, linear_id, identifier
    FROM reassess_requests
    WHERE processed_at IS NULL
  `).all() as ReassessRow[]

  for (const req of reassessRequests) {
    db.prepare('DELETE FROM tickets WHERE linear_id = ?').run(req.linear_id)
    db.prepare(`
      UPDATE reassess_requests SET processed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(req.id)
    state.logEvent('triage', `Reassess: deleted ${req.identifier} for re-triage`)
  }

  // ── 1. Poll Linear ───────────────────────────────────────────
  const allIssues = new Map<string, LinearIssueNode>()

  // 1a. Tickets assigned to the configured assignee
  for (const stateType of config.ticket_states) {
    const result = await linearListIssues({
      team: config.team,
      assignee,
      state: stateType,
    })

    if (!result.error) {
      try {
        const issues = JSON.parse(result.output) as LinearIssueNode[]
        for (const issue of issues) {
          allIssues.set(issue.id, issue)
        }
      } catch (err) {
        state.logEvent('triage', `Failed to parse response: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // 1b. Tickets tagged with platform label (only if claim_unassigned is true)
  if (config.claim_unassigned) {
    for (const stateType of config.ticket_states) {
      const result = await linearListIssues({
        team: config.team,
        label: config.labels.platform,
        state: stateType,
      })

      if (!result.error) {
        try {
          const issues = JSON.parse(result.output) as LinearIssueNode[]
          for (const issue of issues) {
            allIssues.set(issue.id, issue)
          }
        } catch (err) {
          state.logEvent('triage', `Failed to parse response: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  // ── 2. Filter already-processed tickets ──────────────────────
  const newIssues: LinearIssueNode[] = []
  for (const issue of allIssues.values()) {
    // Never triage tickets that are already "In Progress" or "In Review"
    if (issue.state.type === 'started') continue

    const existing = db.prepare(
      'SELECT linear_id FROM tickets WHERE linear_id = ?'
    ).get(issue.id)

    if (!existing) {
      newIssues.push(issue)
    }
  }
  found = newIssues.length

  // ── 3. Route previously-triaged-but-not-routed tickets first ─
  let slots = countAvailableSlots(state, maxWorkers)

  const unroutedTriaged = db.prepare(`
    SELECT linear_id, identifier, title, description, target_repo, complexity, route, affected_paths, triage_result
    FROM tickets WHERE status = 'triaged'
    ORDER BY created_at ASC
  `).all() as TriagedTicketRow[]

  for (const ticket of unroutedTriaged) {
    if (!ticket.triage_result) continue

    try {
      const triage = JSON.parse(ticket.triage_result) as TriageResult
      const result = routeTicket({
        config, state,
        linearId: ticket.linear_id,
        identifier: ticket.identifier,
        triage,
        slots,
        spawnRequests,
      })

      if (result.slotUsed) slots--
      if (result.routed === 'execute') executed++
      else if (result.routed === 'explore') explored++
      else if (result.routed === 'reassign') reassigned++
      else if (result.routed === 'skipped') concurrencyDeferred++
    } catch (err) {
      state.logEvent('triage', `Failed to parse response: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 3a+3c. Triage and route new tickets ──────────────────────
  for (const issue of newIssues) {
    // Fetch full context
    const fullIssueResult = await linearGetIssue(issue.id)
    let description: string | null = null
    let estimate: number | null = null

    if (!fullIssueResult.error) {
      try {
        const fullIssue = JSON.parse(fullIssueResult.output)
        description = fullIssue.description ?? null
        estimate = fullIssue.estimate ?? null
      } catch (err) {
        state.logEvent('triage', `Failed to parse response: ${err instanceof Error ? err.message : String(err)}`)
        // Use basic info from list
      }
    }

    // Triage via model call
    try {
      const triage = await triageTicket({
        title: issue.title,
        description,
        priority: issue.priority,
        estimate,
        config,
        state,
      })

      // Record in state DB
      db.prepare(`
        INSERT INTO tickets (linear_id, identifier, title, description, priority, status, triage_result, complexity, route, target_repo, affected_paths, triaged_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'triaged', ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      `).run(
        issue.id,
        issue.identifier,
        issue.title,
        description,
        issue.priority,
        JSON.stringify(triage),
        triage.complexity,
        triage.route,
        triage.target_repo,
        JSON.stringify(triage.affected_paths),
      )
      triaged++

      // Immediately route this ticket
      slots = countAvailableSlots(state, maxWorkers) // Re-check slots

      if (triage.route === 'defer') {
        const deferred_ok = await deferTicket({
          state,
          linearId: issue.id,
          identifier: issue.identifier,
          description,
          triage,
        })
        if (deferred_ok) deferred++
      } else {
        const result = routeTicket({
          config, state,
          linearId: issue.id,
          identifier: issue.identifier,
          triage,
          slots,
          spawnRequests,
        })

        if (result.slotUsed) slots--
        if (result.routed === 'execute') executed++
        else if (result.routed === 'explore') explored++
        else if (result.routed === 'reassign') reassigned++
        else if (result.routed === 'skipped') concurrencyDeferred++
      }
    } catch (err) {
      state.logEvent('triage', `Triage failed for ${issue.identifier}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 4. Poll deferred tickets ─────────────────────────────────
  slots = countAvailableSlots(state, maxWorkers)
  await pollDeferredTickets({ config, state, slots, spawnRequests })

  // ── 5. Log summary ──────────────────────────────────────────
  const runningWorkers = (maxWorkers - countAvailableSlots(state, maxWorkers))
  if (concurrencyDeferred > 0) {
    state.logEvent('triage', `Concurrency limit: queued ${executed + explored} workers, deferred ${concurrencyDeferred} tickets (${runningWorkers}/${maxWorkers} slots used)`)
  }

  const summary = `TRIAGE: found=${found} triaged=${triaged} executed=${executed} explored=${explored} reassigned=${reassigned} deferred=${deferred} concurrency_deferred=${concurrencyDeferred}`
  state.logEvent('triage', summary)

  return {
    summary,
    spawnRequests,
  }
}
