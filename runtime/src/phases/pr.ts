import type { MarvinConfig } from '../types.js'
import type { StateManager } from '../state.js'
import type { PhaseResult } from './types.js'
import { bashExec } from '../tools/bash.js'

// ─── Row types ──────────────────────────────────────────────────────

interface GhPrJson {
  number: number
  title: string
  url: string
  headRefName: string
  headRefOid: string
  isDraft: boolean
  reviewDecision: string | null
  statusCheckRollup: Array<{ state: string; conclusion: string | null }> | null
  createdAt: string
  updatedAt: string
  mergeable: string
  mergeStateStatus: string
  author?: { login: string }
}

// ─── Helpers ────────────────────────────────────────────────────────

function computeCiStatus(checks: GhPrJson['statusCheckRollup']): string {
  if (!checks || checks.length === 0) return 'neutral'

  let hasFailure = false
  let hasPending = false

  for (const check of checks) {
    const conclusion = check.conclusion?.toUpperCase()
    const state = check.state?.toUpperCase()

    if (conclusion === 'FAILURE' || state === 'FAILURE' || state === 'ERROR') {
      hasFailure = true
    } else if (state === 'PENDING' || state === 'EXPECTED' || (!conclusion && state !== 'COMPLETED')) {
      hasPending = true
    }
    // SUCCESS, NEUTRAL, SKIPPED are all ok
  }

  if (hasFailure) return 'failure'
  if (hasPending) return 'pending'
  return 'success'
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

// ─── PR polling ─────────────────────────────────────────────────────

function pollOpenPrs(opts: {
  config: MarvinConfig
  state: StateManager
}): number {
  const { config, state } = opts
  const db = state.raw()
  let polled = 0

  // Prepare upsert statement
  const upsertStmt = db.prepare(`
    INSERT INTO pull_requests (
      pr_number, repo, title, url, head_branch, state, is_draft,
      ci_status, review_decision, head_sha, author, mergeable, merge_state,
      gh_created_at, gh_updated_at, ticket_linear_id, last_polled_at
    ) VALUES (
      ?, ?, ?, ?, ?, 'open', ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    )
    ON CONFLICT(repo, pr_number) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      head_branch = excluded.head_branch,
      state = excluded.state,
      is_draft = excluded.is_draft,
      ci_status = excluded.ci_status,
      review_decision = excluded.review_decision,
      head_sha = excluded.head_sha,
      author = excluded.author,
      mergeable = excluded.mergeable,
      merge_state = excluded.merge_state,
      gh_created_at = excluded.gh_created_at,
      gh_updated_at = excluded.gh_updated_at,
      ticket_linear_id = COALESCE(excluded.ticket_linear_id, pull_requests.ticket_linear_id),
      rebase_status = CASE
        WHEN excluded.mergeable = 'MERGEABLE' AND pull_requests.rebase_status IN ('conflict','exhausted')
        THEN NULL ELSE pull_requests.rebase_status END,
      rebase_count = CASE
        WHEN excluded.mergeable = 'MERGEABLE' AND pull_requests.rebase_status IN ('conflict','exhausted')
        THEN 0 ELSE pull_requests.rebase_count END,
      rebase_error = CASE
        WHEN excluded.mergeable = 'MERGEABLE' AND pull_requests.rebase_status IN ('conflict','exhausted')
        THEN NULL ELSE pull_requests.rebase_error END,
      last_polled_at = excluded.last_polled_at
  `)

  const fetchedPrKeys = new Set<string>()
  const successfulRepos = new Set<string>()

  for (const [repoName, repoPath] of Object.entries(config.repos)) {
    // Fetch PRs by the configured user
    const result = bashExec({
      command: `gh pr list --repo ${config.github_org}/${repoName} --author ${config.github_user} --state open --json number,title,url,headRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup,createdAt,updatedAt,mergeable,mergeStateStatus`,
      timeout: 30_000,
    })

    if (result.error) {
      state.logEvent('phase_pr', `Failed to fetch PRs for ${repoName}: ${result.error}`)
      continue
    }

    let prs: GhPrJson[]
    try {
      prs = JSON.parse(result.output)
    } catch {
      state.logEvent('phase_pr', `Failed to parse PR JSON for ${repoName}`)
      continue
    }

    for (const pr of prs) {
      const ciStatus = computeCiStatus(pr.statusCheckRollup)
      const isDraft = pr.isDraft ? 1 : 0
      const author = config.github_user

      // Link to ticket if branch matches pattern
      let ticketLinearId: string | null = null
      const branchMatch = pr.headRefName.match(new RegExp(`${config.branch_prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/gm-(\\d+)-`))
      if (branchMatch) {
        const ticketNum = branchMatch[1]
        const ticketRow = db.prepare(
          `SELECT linear_id FROM tickets WHERE identifier LIKE 'GM-${ticketNum}'`
        ).get() as { linear_id: string } | undefined
        ticketLinearId = ticketRow?.linear_id ?? null
      }

      upsertStmt.run(
        pr.number,
        repoName,
        pr.title,
        pr.url,
        pr.headRefName,
        isDraft,
        ciStatus,
        pr.reviewDecision,
        pr.headRefOid,
        author,
        pr.mergeable,
        pr.mergeStateStatus,
        pr.createdAt,
        pr.updatedAt,
        ticketLinearId,
      )

      fetchedPrKeys.add(`${repoName}:${pr.number}`)
      polled++
    }

    successfulRepos.add(repoName)
  }

  // Mark disappeared PRs (open in DB but not fetched)
  const openInDb = db.prepare(
    "SELECT pr_number, repo, ticket_linear_id FROM pull_requests WHERE state = 'open'"
  ).all() as Array<{ pr_number: number; repo: string; ticket_linear_id: string | null }>

  for (const dbPr of openInDb) {
    // Only check for disappeared PRs in repos we successfully polled
    if (!successfulRepos.has(dbPr.repo)) continue
    const key = `${dbPr.repo}:${dbPr.pr_number}`
    if (!fetchedPrKeys.has(key)) {
      // Check actual state on GitHub
      const viewResult = bashExec({
        command: `gh pr view ${dbPr.pr_number} --repo ${config.github_org}/${dbPr.repo} --json state -q '.state' 2>/dev/null`,
        timeout: 15_000,
      })

      const finalState = viewResult.output.trim().toLowerCase()
      if (finalState === 'merged' || finalState === 'closed') {
        db.prepare(`
          UPDATE pull_requests SET state = ?, last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE repo = ? AND pr_number = ?
        `).run(finalState, dbPr.repo, dbPr.pr_number)

        // If merged and has linked ticket, mark ticket as merged
        if (finalState === 'merged' && dbPr.ticket_linear_id) {
          db.prepare(`
            UPDATE tickets SET status = 'merged', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE linear_id = ? AND status = 'done'
          `).run(dbPr.ticket_linear_id)
        }

        state.logEvent('phase_pr', `PR ${dbPr.repo}#${dbPr.pr_number} ${finalState}`)
      }
    }
  }

  return polled
}

// ─── CI failure detection ───────────────────────────────────────────

function detectCiFailures(opts: {
  config: MarvinConfig
  state: StateManager
}): number {
  const { config, state } = opts
  const db = state.raw()
  let ciFixCount = 0
  const maxAttempts = config.limits.ci_fix_max_attempts ?? 5
  const minIntervalMin = config.limits.ci_fix_min_interval_minutes ?? 10

  // Recovery — clear stale statuses when CI passes
  db.prepare(`
    UPDATE pull_requests
    SET ci_fix_status = NULL, ci_fix_count = 0, ci_fix_error = NULL
    WHERE state = 'open'
      AND ci_fix_status IN ('exhausted', 'infrastructure_skip')
      AND ci_status = 'success'
  `).run()

  // Mark infrastructure failures
  db.prepare(`
    UPDATE pull_requests
    SET ci_fix_status = 'infrastructure_skip'
    WHERE state = 'open'
      AND ci_status = 'failure'
      AND ci_fix_error IS NOT NULL
      AND (ci_fix_error LIKE '%infrastructure%' OR ci_fix_error LIKE '%CI config%' OR ci_fix_error LIKE '%stale%node%' OR ci_fix_error LIKE '%GitHub Action%failed%')
      AND (ci_fix_status IS NULL OR ci_fix_status NOT IN ('pending_fix', 'fix_in_progress', 'exhausted', 'infrastructure_skip'))
  `).run()

  // Find PRs needing CI fix
  const candidates = db.prepare(`
    SELECT pr_number, repo, title, url, head_branch, ci_fix_count, ci_fix_status, ci_fix_error, ticket_linear_id
    FROM pull_requests
    WHERE state = 'open'
      AND ci_status = 'failure'
      AND (ci_fix_status IS NULL OR ci_fix_status NOT IN ('pending_fix', 'fix_in_progress', 'exhausted', 'infrastructure_skip'))
      AND ci_fix_count < ?
      AND (ci_fix_last_attempt_at IS NULL OR ci_fix_last_attempt_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${minIntervalMin} minutes'))
  `).all(maxAttempts) as Array<{
    pr_number: number; repo: string; title: string; url: string
    head_branch: string; ci_fix_count: number; ci_fix_status: string | null
    ci_fix_error: string | null; ticket_linear_id: string | null
  }>

  for (const pr of candidates) {
    // Check no active ci_fix_run
    const activeRun = db.prepare(`
      SELECT id FROM ci_fix_runs
      WHERE repo = ? AND pr_number = ? AND status IN ('running', 'queued')
    `).get(pr.repo, pr.pr_number)

    if (activeRun) continue

    // Set pending_fix
    db.prepare(`
      UPDATE pull_requests SET ci_fix_status = 'pending_fix'
      WHERE repo = ? AND pr_number = ?
    `).run(pr.repo, pr.pr_number)

    ciFixCount++
  }

  // Exhaustion check
  db.prepare(`
    UPDATE pull_requests
    SET ci_fix_status = 'exhausted'
    WHERE state = 'open' AND ci_status = 'failure'
      AND ci_fix_count >= ?
      AND (ci_fix_status IS NULL OR ci_fix_status != 'exhausted')
  `).run(maxAttempts)

  return ciFixCount
}

// ─── Spawn CI-fix workers ───────────────────────────────────────────

function spawnCiFixWorkers(opts: {
  config: MarvinConfig
  state: StateManager
  slots: number
}): { queued: number; slotsUsed: number } {
  const { config, state } = opts
  let { slots } = opts
  const db = state.raw()
  let queued = 0

  const pendingFixes = db.prepare(`
    SELECT pr_number, repo, head_branch, ticket_linear_id, head_sha
    FROM pull_requests
    WHERE ci_fix_status = 'pending_fix'
  `).all() as Array<{
    pr_number: number; repo: string; head_branch: string
    ticket_linear_id: string | null; head_sha: string | null
  }>

  for (const pr of pendingFixes) {
    if (slots <= 0) break

    // Determine worktree path
    let worktreePath: string | null = null
    if (pr.ticket_linear_id) {
      const ticket = db.prepare(
        'SELECT worktree_path FROM tickets WHERE linear_id = ?'
      ).get(pr.ticket_linear_id) as { worktree_path: string | null } | undefined
      worktreePath = ticket?.worktree_path ?? null
    }

    const repoPath = config.repos[pr.repo]
    if (!repoPath) continue

    // Insert ci_fix_runs row with queued status
    const runResult = db.prepare(`
      INSERT INTO ci_fix_runs (pr_number, repo, status)
      VALUES (?, ?, 'queued')
    `).run(pr.pr_number, pr.repo)
    const ciFixRunId = runResult.lastInsertRowid

    // Update PR state
    db.prepare(`
      UPDATE pull_requests
      SET ci_fix_status = 'fix_in_progress',
          ci_fix_count = ci_fix_count + 1,
          ci_fix_last_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE repo = ? AND pr_number = ?
    `).run(pr.repo, pr.pr_number)

    // Queue ci-fix worker in spawn_queue
    state.queueSpawn({
      workerType: 'ci_fix',
      workerName: `ci-fix-${pr.repo}-${pr.pr_number}`,
      prompt: JSON.stringify({
        pr_number: pr.pr_number,
        repo: `${config.github_org}/${pr.repo}`,
        target_repo: pr.repo,
        worktree_path: worktreePath,
        branch_name: pr.head_branch,
        repo_path: repoPath,
        ci_fix_run_id: Number(ciFixRunId),
        head_sha: pr.head_sha,
      }),
    })

    slots--
    queued++
    state.logEvent('phase_pr', `Queued CI-fix for ${pr.repo}#${pr.pr_number}`)
  }

  return { queued, slotsUsed: queued }
}

// ─── Audit detection ────────────────────────────────────────────────

function detectAuditCandidates(opts: {
  config: MarvinConfig
  state: StateManager
}): number {
  const { config, state } = opts
  const db = state.raw()

  // Primary audit repo is the first repo
  const primaryRepo = Object.keys(config.repos)[0]
  if (!primaryRepo) return 0

  // Reset stale audit statuses
  db.prepare(`
    UPDATE pull_requests
    SET audit_status = NULL
    WHERE repo = ?
      AND audit_status = 'audit_in_progress'
      AND NOT EXISTS (
        SELECT 1 FROM audit_runs
        WHERE audit_runs.repo = pull_requests.repo
          AND audit_runs.pr_number = pull_requests.pr_number
          AND audit_runs.status IN ('running', 'queued')
      )
  `).run(primaryRepo)

  // Find audit candidates — open, non-draft, unaudited at current SHA
  const candidates = db.prepare(`
    SELECT pr_number, repo, title, url, head_branch, head_sha, author
    FROM pull_requests
    WHERE repo = ?
      AND state = 'open' AND is_draft = 0
      AND (audit_status IS NULL OR (audit_status = 'audited' AND head_sha != audit_last_sha))
      AND (audit_status IS NULL OR audit_status NOT IN ('pending_audit', 'audit_in_progress'))
      AND head_sha IS NOT NULL
  `).all(primaryRepo) as Array<{
    pr_number: number; repo: string; title: string; url: string
    head_branch: string; head_sha: string; author: string | null
  }>

  for (const pr of candidates) {
    db.prepare(`
      UPDATE pull_requests SET audit_status = 'pending_audit'
      WHERE repo = ? AND pr_number = ?
    `).run(pr.repo, pr.pr_number)
  }

  return candidates.length
}

// ─── Spawn audit workers ────────────────────────────────────────────

function spawnAuditWorkers(opts: {
  config: MarvinConfig
  state: StateManager
  slots: number
}): { queued: number; slotsUsed: number } {
  const { config, state } = opts
  let { slots } = opts
  const db = state.raw()
  let queued = 0

  const primaryRepo = Object.keys(config.repos)[0]
  if (!primaryRepo) return { queued: 0, slotsUsed: 0 }

  const pendingAudits = db.prepare(`
    SELECT pr_number, repo, head_sha, title, author
    FROM pull_requests
    WHERE audit_status = 'pending_audit'
      AND repo = ?
  `).all(primaryRepo) as Array<{
    pr_number: number; repo: string; head_sha: string
    title: string; author: string | null
  }>

  for (const pr of pendingAudits) {
    if (slots <= 0) break

    // Insert audit_runs row with queued status
    const runResult = db.prepare(`
      INSERT INTO audit_runs (pr_number, repo, head_sha, status)
      VALUES (?, ?, ?, 'queued')
    `).run(pr.pr_number, primaryRepo, pr.head_sha)
    const auditRunId = runResult.lastInsertRowid

    // Set audit_in_progress
    db.prepare(`
      UPDATE pull_requests SET audit_status = 'audit_in_progress'
      WHERE repo = ? AND pr_number = ?
    `).run(pr.repo, pr.pr_number)

    // Check for previous audit (re-review context)
    const previousAudit = db.prepare(`
      SELECT id, risk_level, size_label, findings_count, head_sha
      FROM audit_runs
      WHERE repo = ? AND pr_number = ? AND status = 'completed'
      ORDER BY finished_at DESC LIMIT 1
    `).get(primaryRepo, pr.pr_number) as {
      id: number; risk_level: string | null; size_label: string | null
      findings_count: number; head_sha: string
    } | undefined

    const promptData: Record<string, unknown> = {
      pr_number: pr.pr_number,
      repo: `${config.github_org}/${primaryRepo}`,
      target_repo: primaryRepo,
      repo_path: config.repos[primaryRepo],
      head_sha: pr.head_sha,
      audit_run_id: Number(auditRunId),
    }

    if (previousAudit) {
      promptData.previous_audit_risk = previousAudit.risk_level
      promptData.previous_audit_sha = previousAudit.head_sha
    }

    // Queue auditor in spawn_queue
    state.queueSpawn({
      workerType: 'auditor',
      workerName: `audit-${primaryRepo}-${pr.pr_number}`,
      prompt: JSON.stringify(promptData),
    })

    slots--
    queued++
    state.logEvent('phase_pr', `Queued audit for ${primaryRepo}#${pr.pr_number}`)
  }

  return { queued, slotsUsed: queued }
}

// ─── Main phase ─────────────────────────────────────────────────────

export async function runPhasePR(
  config: MarvinConfig,
  state: StateManager,
): Promise<PhaseResult> {
  const db = state.raw()
  const maxWorkers = config.limits.max_concurrent_workers ?? 8

  // Counters
  let polled = 0
  let ciFixQueued = 0
  let auditQueued = 0
  let concurrencyDeferred = 0

  // ── 0. Early exit check ──────────────────────────────────────
  const openPrs = db.prepare('SELECT COUNT(*) AS count FROM pull_requests WHERE state = ?').get('open') as { count: number }
  const activeTickets = db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE status IN ('executing', 'exploring')").get() as { count: number }

  if (openPrs.count === 0 && activeTickets.count === 0) {
    state.logEvent('phase_pr', 'Skipped — no open PRs or active tickets')
    return {
      summary: 'PR: skipped (no open PRs or active tickets)',
      spawnRequests: [],
    }
  }

  // ── 1. Poll open PRs ────────────────────────────────────────
  polled = pollOpenPrs({ config, state })

  // ── 2. Detect CI failures ───────────────────────────────────
  const ciFixDetected = detectCiFailures({ config, state })

  // ── 3. Spawn CI-fix workers ─────────────────────────────────
  let slots = countAvailableSlots(state, maxWorkers)
  const ciFixResult = spawnCiFixWorkers({ config, state, slots })
  ciFixQueued = ciFixResult.queued
  slots -= ciFixResult.slotsUsed
  concurrencyDeferred += (ciFixDetected - ciFixQueued)

  // ── 4. Detect audit candidates ──────────────────────────────
  const auditDetected = detectAuditCandidates({ config, state })

  // ── 5. Spawn audit workers ──────────────────────────────────
  slots = countAvailableSlots(state, maxWorkers) // Re-check slots
  const auditResult = spawnAuditWorkers({ config, state, slots })
  auditQueued = auditResult.queued
  concurrencyDeferred += (auditDetected - auditQueued)

  // ── TODO: Steps 6-10 (review comments, undraft, rebase, docs) ──
  // These follow the same mechanical pattern:
  // - Poll review comments: gh api → filter → upsert review_comments → set pending_review
  // - Spawn reviewers: query pending_review → create review_runs → queue spawn
  // - Undraft: query ready PRs → gh pr ready → update is_draft
  // - Auto-rebase: query behind PRs → git rebase → push
  // - Docs: scan /tmp/marvin-knowledge-*.json → create doc_runs → queue spawn

  const summary = `PR: polled=${polled} ci_fix=${ciFixQueued} audit=${auditQueued} concurrency_deferred=${concurrencyDeferred}`
  state.logEvent('phase_pr', summary)

  return {
    summary,
    spawnRequests: [],
  }
}
