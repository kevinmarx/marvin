import { EventEmitter } from 'node:events'
import { loadConfig, resolveDbPath } from './config.js'
import { StateManager } from './state.js'
import { loadSkill } from './skills.js'
import { selectModel } from './router/router.js'
import { chat } from './router/client.js'
import { startRun } from './router/feedback.js'
import { getToolDefinitions, executeToolCall } from './tools/index.js'
import { createSafetyChecks, runSafetyChecks } from './safety.js'
import { estimateTokens, compactMessages, truncateToolResult } from './context.js'
import type { AgentOpts, Message, SafetyContext } from './types.js'

const MAX_CONTEXT_TOKENS = 180_000
const COMPACT_THRESHOLD = 0.8

// ─── Event types ────────────────────────────────────────────────────

export interface AgentEventEmitter extends EventEmitter {
  // Outbound events (agent → listener)
  on(event: 'thinking', listener: (content: string) => void): this
  on(event: 'tool_call', listener: (name: string, args: string) => void): this
  on(event: 'tool_result', listener: (name: string, result: string) => void): this
  on(event: 'text', listener: (content: string) => void): this
  on(event: 'model_selected', listener: (model: string) => void): this
  on(event: 'complete', listener: (result: { success: boolean; turns: number; tokensUsed: number }) => void): this
  on(event: 'error', listener: (error: string) => void): this

  // Inbound events (listener → agent)
  on(event: 'inject_message', listener: (content: string) => void): this

  emit(event: 'thinking', content: string): boolean
  emit(event: 'tool_call', name: string, args: string): boolean
  emit(event: 'tool_result', name: string, result: string): boolean
  emit(event: 'text', content: string): boolean
  emit(event: 'model_selected', model: string): boolean
  emit(event: 'complete', result: { success: boolean; turns: number; tokensUsed: number }): boolean
  emit(event: 'error', error: string): boolean
  emit(event: 'inject_message', content: string): boolean
}

export interface RunResult {
  success: boolean
  turns: number
  tokensUsed: number
  model: string
  error?: string
}

// ─── Agent spawn opts (extends AgentOpts with AbortSignal) ──────────

interface AgentWithEventsOpts extends AgentOpts {
  signal?: AbortSignal
}

// ─── Main export ────────────────────────────────────────────────────

export function runAgentWithEvents(opts: AgentWithEventsOpts): {
  events: AgentEventEmitter
  result: Promise<RunResult>
} {
  const events = new EventEmitter() as AgentEventEmitter
  events.setMaxListeners(20)

  // Pending injected messages queue — the agent loop drains this
  const injectedMessages: string[] = []
  events.on('inject_message', (content) => {
    injectedMessages.push(content)
  })

  const result = runLoop(opts, events, injectedMessages)

  return { events, result }
}

// ─── Agent loop (mirrors runAgent but emits events) ─────────────────

async function runLoop(
  opts: AgentWithEventsOpts,
  events: AgentEventEmitter,
  injectedMessages: string[],
): Promise<RunResult> {
  const config = loadConfig()
  const dbPath = resolveDbPath(config)
  const state = new StateManager(dbPath)
  const db = state.raw()

  // Load skill prompt and substitute args
  const systemPrompt = loadSkill(opts.skill, opts.args, config.marvin_repo_path)

  // Route to best model for this task
  const routingContext = {
    skill: opts.skill,
    phase: opts.phase,
    language: opts.args.language,
    complexity: opts.args.complexity ? parseInt(opts.args.complexity) : undefined,
    taskType: opts.args.task_type,
  }
  const routing = selectModel({ ctx: routingContext, db })

  const model = opts.model
    ? config.routing?.providers[opts.model]?.litellm_model ?? routing.litellmModel
    : routing.litellmModel

  events.emit('model_selected', routing.model)

  // Setup safety checks
  const safetyContext: SafetyContext = {
    worktreePath: opts.args.worktree_path,
    branchName: opts.args.branch_name,
    repoPath: opts.args.repo_path,
    skill: opts.skill,
  }
  const safetyChecks = createSafetyChecks({ stateManager: state, config })

  // Start feedback tracking
  const run = startRun({
    skill: opts.skill,
    model: routing.model,
    routingContext,
    ticketId: opts.ticketId,
    ticketIdentifier: opts.identifier,
    db,
  })

  // Build initial message history
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: buildUserPrompt(opts) },
  ]

  const toolDefs = getToolDefinitions()
  let turnCount = 0
  let totalTokens = 0
  const maxTurns = opts.maxTurns ?? 200

  try {
    while (turnCount < maxTurns) {
      // Check for abort
      if (opts.signal?.aborted) {
        throw new Error('Agent interrupted')
      }

      turnCount++

      // Drain any injected messages before the next model call
      while (injectedMessages.length > 0) {
        const injected = injectedMessages.shift()!
        messages.push({ role: 'user', content: injected })
      }

      const response = await chat({
        model,
        messages,
        tools: toolDefs,
      })

      run.trackTokens(response.usage)
      totalTokens += response.usage.input_tokens + response.usage.output_tokens

      // Model finished — no more tool calls
      if (!response.toolCalls || response.toolCalls.length === 0) {
        messages.push({ role: 'assistant', content: response.content ?? '' })

        if (response.content) {
          events.emit('text', response.content)
        }

        break
      }

      // Emit thinking if there's content alongside tool calls
      if (response.content) {
        events.emit('thinking', response.content)
      }

      // Process tool calls
      messages.push({
        role: 'assistant',
        content: response.content ?? '',
        tool_calls: response.toolCalls,
      })

      for (const toolCall of response.toolCalls) {
        // Check for abort between tool calls
        if (opts.signal?.aborted) {
          throw new Error('Agent interrupted')
        }

        run.trackToolCall()

        // Emit tool_call event
        events.emit('tool_call', toolCall.function.name, toolCall.function.arguments)

        // Safety check
        const safetyResult = await runSafetyChecks(toolCall, safetyChecks, safetyContext)
        if (!safetyResult.allowed) {
          const blockedMsg = `BLOCKED by safety check: ${safetyResult.reason}`
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: blockedMsg,
          })
          events.emit('tool_result', toolCall.function.name, blockedMsg)
          continue
        }

        // Execute the tool
        const result = await executeToolCall(toolCall)
        const truncated = truncateToolResult(
          result.error ? `ERROR: ${result.error}\n${result.output}` : result.output,
        )

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: truncated,
        })

        // Emit tool_result — send a shorter version to clients
        events.emit('tool_result', toolCall.function.name, truncate(truncated, 2000))
      }

      // Heartbeat — signal liveness to the ops phase reaper
      if (opts.ticketId) {
        state.updateTicketPhase(opts.ticketId, opts.phase ?? opts.skill)
      }

      // Context window management
      const tokenEstimate = estimateTokens(messages)
      if (tokenEstimate > MAX_CONTEXT_TOKENS * COMPACT_THRESHOLD) {
        const compacted = compactMessages(messages, MAX_CONTEXT_TOKENS)
        messages.length = 0
        messages.push(...compacted)
      }
    }

    // Success
    const runResult: RunResult = {
      success: true,
      turns: turnCount,
      tokensUsed: totalTokens,
      model: routing.model,
    }

    run.complete({ success: true })
    events.emit('complete', { success: true, turns: turnCount, tokensUsed: totalTokens })

    return runResult
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    run.fail(errorMessage)
    events.emit('error', errorMessage)

    return {
      success: false,
      turns: turnCount,
      tokensUsed: totalTokens,
      model: routing.model,
      error: errorMessage,
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildUserPrompt(opts: AgentOpts): string {
  const lines = [`Execute the ${opts.skill} skill with these arguments:`]
  for (const [key, value] of Object.entries(opts.args)) {
    lines.push(`- ${key}: ${value}`)
  }
  return lines.join('\n')
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...'
}
