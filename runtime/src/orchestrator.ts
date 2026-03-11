import { loadConfig, resolveDbPath } from './config.js'
import { StateManager } from './state.js'
import { SpawnManager } from './spawn.js'
import { runPhaseOps } from './phases/ops.js'
import { runPhaseTriage } from './phases/triage.js'
import { runPhasePR } from './phases/pr.js'
import type { SpawnRequest } from './phases/types.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function drainAndSpawn(
  requests: SpawnRequest[],
  spawn: SpawnManager,
  state: StateManager,
): void {
  for (const req of requests) {
    if (spawn.availableSlots <= 0) {
      state.logEvent('spawn', `Skipped ${req.identifier ?? req.id}: no slots (${spawn.runningCount}/${spawn.runningCount + spawn.availableSlots} workers running)`)
      // Roll back ticket status if needed
      if (req.ticketId) {
        state.updateTicketStatus(req.ticketId, 'triaged')
      }
      continue
    }

    const result = spawn.spawn(req)
    if (result.spawned) {
      state.logEvent('spawn', `Spawned ${req.skill} for ${req.identifier ?? req.id}`)
    } else {
      state.logEvent('spawn', `Failed to spawn ${req.skill} for ${req.identifier ?? req.id}: ${result.reason}`)
      if (req.ticketId) {
        state.updateTicketStatus(req.ticketId, 'triaged')
      }
    }
  }
}

export async function runOrchestrator() {
  const config = loadConfig()
  const dbPath = resolveDbPath(config)
  const state = new StateManager(dbPath)
  const maxWorkers = config.limits.max_concurrent_workers
  const spawn = new SpawnManager(maxWorkers)

  let cycleCount = 0
  let consecutiveIdleCycles = 0
  const maxCycles = config.self_restart_after_cycles
  const maxIdleMultiplier = config.limits.idle_multiplier_max

  console.log(`Marvin orchestrator starting (max ${maxCycles} cycles, ${maxWorkers} max workers)`)

  // Graceful shutdown on SIGTERM/SIGINT
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\nReceived ${signal}, shutting down...`)
    spawn.killAll()
    state.updateHeartbeat('shutdown')
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  while (cycleCount < maxCycles) {
    if (shuttingDown) break

    cycleCount++
    const cycleStart = Date.now()
    state.incrementCycle()
    state.updateHeartbeat('starting')
    state.logEvent('cycle', `Cycle ${cycleCount} starting`)

    // ── Phase 1: Ops ────────────────────────────────────────────
    state.updateHeartbeat('phase_ops')
    try {
      const opsResult = await runPhaseOps(config, state, spawn)
      state.logEvent('phase_ops', opsResult.summary)
      console.log(`[cycle ${cycleCount}] Ops: ${opsResult.summary}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      state.logEvent('phase_ops', `ERROR: ${msg}`)
      console.error(`[cycle ${cycleCount}] Ops phase error: ${msg}`)
    }

    // ── Phase 2: Triage ─────────────────────────────────────────
    state.updateHeartbeat('phase_triage')
    let triageSpawnCount = 0
    let triageIdle = true
    try {
      const triageResult = await runPhaseTriage(config, state)
      state.logEvent('phase_triage', triageResult.summary)
      console.log(`[cycle ${cycleCount}] Triage: ${triageResult.summary}`)

      triageSpawnCount = triageResult.spawnRequests.length
      triageIdle = triageSpawnCount === 0
        && /triaged=0/.test(triageResult.summary)

      // Drain: spawn workers from triage
      drainAndSpawn(triageResult.spawnRequests, spawn, state)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      state.logEvent('phase_triage', `ERROR: ${msg}`)
      console.error(`[cycle ${cycleCount}] Triage phase error: ${msg}`)
    }

    // ── Phase 3: PR management ──────────────────────────────────
    state.updateHeartbeat('phase_pr')
    let prSpawnCount = 0
    let prIdle = true
    try {
      const prResult = await runPhasePR(config, state)
      state.logEvent('phase_pr', prResult.summary)
      console.log(`[cycle ${cycleCount}] PR: ${prResult.summary}`)

      prSpawnCount = prResult.spawnRequests.length
      prIdle = prSpawnCount === 0
        && !/undrafted=[1-9]/.test(prResult.summary)

      // Drain: spawn workers from PR phase
      drainAndSpawn(prResult.spawnRequests, spawn, state)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      state.logEvent('phase_pr', `ERROR: ${msg}`)
      console.error(`[cycle ${cycleCount}] PR phase error: ${msg}`)
    }

    // ── Record cycle duration ───────────────────────────────────
    const cycleDurationSeconds = Math.round((Date.now() - cycleStart) / 1000)
    state.recordCycleDuration(cycleDurationSeconds)
    console.log(`[cycle ${cycleCount}] Completed in ${cycleDurationSeconds}s, ${spawn.runningCount} workers active`)

    // ── Idle detection ───────────────────────────────────────────
    const cycleWasIdle = triageIdle && prIdle && spawn.runningCount === 0
    if (cycleWasIdle) {
      consecutiveIdleCycles++
    } else {
      consecutiveIdleCycles = 0
    }

    // ── Self-restart check ──────────────────────────────────────
    if (cycleCount >= maxCycles) {
      state.updateHeartbeat('self_restart')
      state.logEvent('cycle', `Self-restarting after ${cycleCount} cycles to compact context`)
      console.log(`Marvin self-restarting after ${cycleCount} cycles to compact context.`)
      break
    }

    // ── Sleep (adaptive) ───────────────────────────────────────
    const sleepMultiplier = consecutiveIdleCycles >= 3
      ? Math.min(Math.pow(2, consecutiveIdleCycles - 2), maxIdleMultiplier)
      : 1
    const sleepSeconds = config.cycle_interval_seconds * sleepMultiplier
    state.updateHeartbeat('sleeping')
    state.logEvent('sleep', `Sleeping ${sleepSeconds}s (idle: ${consecutiveIdleCycles} cycles, multiplier: ${sleepMultiplier}x)`)
    console.log(`[cycle ${cycleCount}] Sleeping ${sleepSeconds}s (idle: ${consecutiveIdleCycles} cycles, ${sleepMultiplier}x)`)
    await sleep(sleepSeconds * 1000)
  }

  // Self-restart: kill all workers, exit cleanly
  spawn.killAll()
  process.exit(0)
}
