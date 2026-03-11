import { fork, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Resolve the agent entry point relative to this file
const AGENT_PATH = path.join(__dirname, 'agent.ts')

interface WorkerInfo {
  process: ChildProcess
  skill: string
  ticketId?: string
  identifier?: string
  startedAt: number
  lastHeartbeat: number
  cleaned: boolean
}

interface SpawnOpts {
  id: string
  skill: string
  args: Record<string, string>
  ticketId?: string
  identifier?: string
}

interface SpawnResult {
  spawned: boolean
  reason?: string
}

interface WorkerStatus {
  id: string
  skill: string
  ticketId?: string
  identifier?: string
  startedAt: number
  lastHeartbeat: number
  pid: number | undefined
}

interface IPCMessage {
  type: 'heartbeat' | 'complete' | 'failed'
  phase?: string
  success?: boolean
  error?: string
}

export class SpawnManager {
  private workers = new Map<string, WorkerInfo>()
  private maxWorkers: number

  constructor(maxWorkers = 8) {
    this.maxWorkers = maxWorkers
  }

  // Spawn a worker as a child process.
  // The child runs agent.ts with SKILL and ARGS env vars.
  spawn(opts: SpawnOpts): SpawnResult {
    if (this.workers.size >= this.maxWorkers) {
      return { spawned: false, reason: 'concurrency limit' }
    }

    if (this.workers.has(opts.id)) {
      return { spawned: false, reason: `worker ${opts.id} already running` }
    }

    const child = fork(AGENT_PATH, [], {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        SKILL: opts.skill,
        ARGS: JSON.stringify(opts.args),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })

    const info: WorkerInfo = {
      process: child,
      skill: opts.skill,
      ticketId: opts.ticketId,
      identifier: opts.identifier,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      cleaned: false,
    }

    this.workers.set(opts.id, info)

    // Pipe stdout/stderr with worker prefix for log visibility
    const prefix = `[worker:${opts.identifier ?? opts.id}]`
    child.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        console.log(`${prefix} ${line}`)
      }
    })
    child.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        console.error(`${prefix} ${line}`)
      }
    })

    // Handle IPC messages from child
    child.on('message', (msg: IPCMessage) => {
      const worker = this.workers.get(opts.id)
      if (!worker) return

      switch (msg.type) {
        case 'heartbeat':
          worker.lastHeartbeat = Date.now()
          break
        case 'complete':
          console.log(`${prefix} completed (success=${msg.success})`)
          worker.cleaned = true
          this.workers.delete(opts.id)
          break
        case 'failed':
          console.error(`${prefix} failed: ${msg.error}`)
          worker.cleaned = true
          this.workers.delete(opts.id)
          break
      }
    })

    // Handle process exit (crash, signal, or normal exit)
    child.on('exit', (code, signal) => {
      const worker = this.workers.get(opts.id)
      if (worker && !worker.cleaned) {
        if (code !== 0) {
          console.error(`${prefix} exited with code=${code} signal=${signal}`)
        }
        this.workers.delete(opts.id)
      }
    })

    // Handle errors (e.g. spawn failure)
    child.on('error', (err) => {
      console.error(`${prefix} process error: ${err.message}`)
      this.workers.delete(opts.id)
    })

    return { spawned: true }
  }

  // Count running workers
  get runningCount(): number {
    return this.workers.size
  }

  // Available slots
  get availableSlots(): number {
    return Math.max(0, this.maxWorkers - this.workers.size)
  }

  // Check if a specific worker is running
  isRunning(id: string): boolean {
    return this.workers.has(id)
  }

  // Reap stale workers (no heartbeat within threshold).
  // Returns the IDs of reaped workers.
  reap(staleThresholdMs: number): string[] {
    const now = Date.now()
    const reaped: string[] = []

    for (const [id, info] of this.workers) {
      if (now - info.lastHeartbeat > staleThresholdMs) {
        console.warn(`[spawn] Reaping stale worker ${info.identifier ?? id} (${info.skill}, last heartbeat ${Math.round((now - info.lastHeartbeat) / 1000)}s ago)`)
        this.killWorker(id, info)
        reaped.push(id)
      }
    }

    return reaped
  }

  // Kill a specific worker
  kill(id: string): void {
    const info = this.workers.get(id)
    if (!info) return
    this.killWorker(id, info)
  }

  // Kill all workers (for shutdown)
  killAll(): void {
    for (const [id, info] of this.workers) {
      this.killWorker(id, info)
    }
  }

  // Get status of all workers
  getStatus(): WorkerStatus[] {
    const statuses: WorkerStatus[] = []
    for (const [id, info] of this.workers) {
      statuses.push({
        id,
        skill: info.skill,
        ticketId: info.ticketId,
        identifier: info.identifier,
        startedAt: info.startedAt,
        lastHeartbeat: info.lastHeartbeat,
        pid: info.process.pid,
      })
    }
    return statuses
  }

  private killWorker(id: string, info: WorkerInfo): void {
    try {
      // Send SIGTERM first for graceful shutdown
      info.process.kill('SIGTERM')

      // Force kill after 5 seconds if still alive
      const forceKillTimer = setTimeout(() => {
        try {
          info.process.kill('SIGKILL')
        } catch {
          // Process already dead, ignore
        }
      }, 5000)

      // Don't keep the process alive just for this timer
      forceKillTimer.unref()
    } catch {
      // Process already dead, ignore
    }

    this.workers.delete(id)
  }
}
