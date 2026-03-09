import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { loadConfig, resolveDbPath } from './config.js'
import { StateManager } from './state.js'
import { runAgentWithEvents } from './agent-events.js'
import type { SkillName } from './types.js'
import type { AgentEventEmitter, RunResult } from './agent-events.js'

// ─── Message types ──────────────────────────────────────────────────

type ClientMessage =
  | { type: 'spawn'; skill: SkillName; args: Record<string, string>; model?: string }
  | { type: 'interrupt'; agentId: string }
  | { type: 'message'; agentId: string; content: string }
  | { type: 'list_agents' }
  | { type: 'get_status' }

type ServerMessage =
  | { type: 'agent_spawned'; agentId: string; skill: string; model: string }
  | { type: 'agent_output'; agentId: string; kind: 'thinking' | 'tool_call' | 'tool_result' | 'text'; content: string }
  | { type: 'agent_completed'; agentId: string; success: boolean; turns: number; tokensUsed: number }
  | { type: 'agent_failed'; agentId: string; error: string }
  | { type: 'agent_interrupted'; agentId: string }
  | { type: 'agent_list'; agents: AgentSummary[] }
  | { type: 'status'; autonomous: { running: boolean; cycle: number }; agents: number }
  | { type: 'error'; message: string }

interface AgentSummary {
  id: string
  skill: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  model: string
}

// ─── Tracked agent ──────────────────────────────────────────────────

interface RealtimeAgent {
  id: string
  skill: SkillName
  args: Record<string, string>
  model: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  controller: AbortController
  result: Promise<RunResult>
  events: AgentEventEmitter
}

// ─── RealtimeServer ─────────────────────────────────────────────────

export class RealtimeServer {
  private wss: WebSocketServer | null = null
  private agents = new Map<string, RealtimeAgent>()
  private clients = new Set<WebSocket>()
  private state: StateManager
  private config: ReturnType<typeof loadConfig>
  private port: number

  constructor(port = 7780) {
    this.port = port
    this.config = loadConfig()
    const dbPath = resolveDbPath(this.config)
    this.state = new StateManager(dbPath)
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.port })

    this.wss.on('connection', (ws) => {
      this.clients.add(ws)

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientMessage
          this.handleMessage(ws, msg)
        } catch (err) {
          this.send(ws, {
            type: 'error',
            message: `Invalid message: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      })

      ws.on('close', () => {
        this.clients.delete(ws)
      })

      ws.on('error', (err) => {
        console.error('[realtime] WebSocket error:', err.message)
        this.clients.delete(ws)
      })
    })

    this.wss.on('error', (err) => {
      console.error('[realtime] Server error:', err.message)
    })
  }

  stop(): void {
    // Interrupt all running agents
    for (const [id, agent] of this.agents) {
      if (agent.status === 'running') {
        agent.controller.abort()
        agent.status = 'failed'
        this.broadcast({ type: 'agent_interrupted', agentId: id })
      }
    }

    // Close all client connections
    for (const ws of this.clients) {
      ws.close(1001, 'server shutting down')
    }
    this.clients.clear()

    // Close the server
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
  }

  // ── Client messaging ─────────────────────────────────────────────

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  private broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload)
      }
    }
  }

  // ── Message dispatch ──────────────────────────────────────────────

  private handleMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'spawn':
        this.handleSpawn(ws, msg)
        break
      case 'interrupt':
        this.handleInterrupt(ws, msg.agentId)
        break
      case 'message':
        this.handleSendToAgent(ws, msg.agentId, msg.content)
        break
      case 'list_agents':
        this.handleListAgents(ws)
        break
      case 'get_status':
        this.handleGetStatus(ws)
        break
    }
  }

  // ── Spawn ─────────────────────────────────────────────────────────

  private handleSpawn(ws: WebSocket, msg: { skill: SkillName; args: Record<string, string>; model?: string }): void {
    try {
      const agentId = this.spawnAgent({
        skill: msg.skill,
        args: msg.args,
        model: msg.model,
      })

      const agent = this.agents.get(agentId)!
      this.send(ws, {
        type: 'agent_spawned',
        agentId,
        skill: msg.skill,
        model: agent.model,
      })
    } catch (err) {
      this.send(ws, {
        type: 'error',
        message: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  private spawnAgent(opts: {
    skill: SkillName
    args: Record<string, string>
    model?: string
  }): string {
    const agentId = randomUUID()
    const controller = new AbortController()

    const { events, result } = runAgentWithEvents({
      skill: opts.skill,
      args: opts.args,
      model: opts.model,
      signal: controller.signal,
    })

    const agent: RealtimeAgent = {
      id: agentId,
      skill: opts.skill,
      args: opts.args,
      model: opts.model ?? 'auto',
      status: 'running',
      startedAt: Date.now(),
      controller,
      result,
      events,
    }

    this.agents.set(agentId, agent)

    // Wire up event listeners → broadcast to all clients
    events.on('thinking', (content) => {
      this.broadcast({ type: 'agent_output', agentId, kind: 'thinking', content })
    })

    events.on('tool_call', (name, args) => {
      this.broadcast({
        type: 'agent_output',
        agentId,
        kind: 'tool_call',
        content: `${name}(${truncate(args, 500)})`,
      })
    })

    events.on('tool_result', (name, resultStr) => {
      this.broadcast({
        type: 'agent_output',
        agentId,
        kind: 'tool_result',
        content: `${name} → ${truncate(resultStr, 1000)}`,
      })
    })

    events.on('text', (content) => {
      this.broadcast({ type: 'agent_output', agentId, kind: 'text', content })
    })

    events.on('model_selected', (model) => {
      agent.model = model
    })

    events.on('complete', ({ success, turns, tokensUsed }) => {
      agent.status = 'completed'
      this.broadcast({ type: 'agent_completed', agentId, success, turns, tokensUsed })
    })

    events.on('error', (error) => {
      agent.status = 'failed'
      this.broadcast({ type: 'agent_failed', agentId, error })
    })

    // Also handle the result promise rejection (shouldn't happen, but safety net)
    result.catch((err) => {
      if (agent.status === 'running') {
        agent.status = 'failed'
        this.broadcast({
          type: 'agent_failed',
          agentId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    return agentId
  }

  // ── Interrupt ─────────────────────────────────────────────────────

  private handleInterrupt(ws: WebSocket, agentId: string): void {
    const agent = this.agents.get(agentId)
    if (!agent) {
      this.send(ws, { type: 'error', message: `Agent not found: ${agentId}` })
      return
    }

    if (agent.status !== 'running') {
      this.send(ws, { type: 'error', message: `Agent ${agentId} is not running (status: ${agent.status})` })
      return
    }

    agent.controller.abort()
    agent.status = 'failed'
    this.broadcast({ type: 'agent_interrupted', agentId })
  }

  // ── Message to agent ──────────────────────────────────────────────

  private handleSendToAgent(ws: WebSocket, agentId: string, content: string): void {
    const agent = this.agents.get(agentId)
    if (!agent) {
      this.send(ws, { type: 'error', message: `Agent not found: ${agentId}` })
      return
    }

    if (agent.status !== 'running') {
      this.send(ws, { type: 'error', message: `Agent ${agentId} is not running (status: ${agent.status})` })
      return
    }

    // Emit an inject event that the agent loop listens for
    agent.events.emit('inject_message', content)
  }

  // ── List / Status ─────────────────────────────────────────────────

  private handleListAgents(ws: WebSocket): void {
    const agents: AgentSummary[] = []
    for (const [id, agent] of this.agents) {
      agents.push({
        id,
        skill: agent.skill,
        status: agent.status,
        startedAt: agent.startedAt,
        model: agent.model,
      })
    }
    this.send(ws, { type: 'agent_list', agents })
  }

  private handleGetStatus(ws: WebSocket): void {
    const heartbeat = this.state.getHeartbeat()
    const runningAgentCount = Array.from(this.agents.values()).filter(a => a.status === 'running').length

    this.send(ws, {
      type: 'status',
      autonomous: {
        running: heartbeat ? isRecent(heartbeat.last_beat_at, 120) : false,
        cycle: heartbeat?.cycle_number ?? 0,
      },
      agents: runningAgentCount,
    })
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...'
}

function isRecent(isoTimestamp: string, maxAgeSeconds: number): boolean {
  const ts = new Date(isoTimestamp).getTime()
  return Date.now() - ts < maxAgeSeconds * 1000
}
