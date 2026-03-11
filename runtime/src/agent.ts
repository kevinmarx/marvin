import { loadConfig, resolveDbPath } from './config.js'
import { StateManager } from './state.js'
import { loadSkill } from './skills.js'
import { selectModel } from './router/router.js'
import { chat } from './router/client.js'
import { startRun } from './router/feedback.js'
import { getToolDefinitions, executeToolCall } from './tools/index.js'
import { createSafetyChecks, runSafetyChecks } from './safety.js'
import { estimateTokens, compactMessages, truncateToolResult } from './context.js'
import type { AgentOpts, Message, SafetyContext, SkillName } from './types.js'

/** Conservative context limit — leaves headroom below model max (200K for Opus, 128K for GPT-5) */
const MAX_CONTEXT_TOKENS = 180_000
/** Trigger compaction at 80% of max to avoid hitting the hard limit mid-turn */
const COMPACT_THRESHOLD = 0.8

export async function runAgent(opts: AgentOpts) {
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
      turnCount++

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
        break
      }

      // Process tool calls
      messages.push({
        role: 'assistant',
        content: response.content ?? '',
        tool_calls: response.toolCalls,
      })

      for (const toolCall of response.toolCalls) {
        run.trackToolCall()

        // Safety check
        const safetyResult = await runSafetyChecks(toolCall, safetyChecks, safetyContext)
        if (!safetyResult.allowed) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `BLOCKED by safety check: ${safetyResult.reason}`,
          })
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
      }

      // Heartbeat — signal liveness to the ops phase reaper
      if (opts.ticketId) {
        state.updateTicketPhase(opts.ticketId, opts.phase ?? opts.skill)
      }

      // IPC heartbeat — signal liveness to the spawn manager
      if (process.send) {
        process.send({ type: 'heartbeat', phase: opts.phase ?? opts.skill })
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
    run.complete({ success: true })

    if (process.send) {
      process.send({ type: 'complete', success: true })
    }

    return {
      success: true,
      turns: turnCount,
      tokensUsed: totalTokens,
      model: routing.model,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    run.fail(errorMessage)

    if (process.send) {
      process.send({ type: 'failed', error: errorMessage })
    }

    return {
      success: false,
      turns: turnCount,
      tokensUsed: totalTokens,
      model: routing.model,
      error: errorMessage,
    }
  }
}

function buildUserPrompt(opts: AgentOpts): string {
  const lines = [`Execute the ${opts.skill} skill with these arguments:`]
  for (const [key, value] of Object.entries(opts.args)) {
    lines.push(`- ${key}: ${value}`)
  }
  return lines.join('\n')
}

// ─── CLI entry point ────────────────────────────────────────────────

async function main() {
  const skill = process.env.SKILL as SkillName
  const args = JSON.parse(process.env.ARGS ?? '{}')

  if (!skill) {
    console.error('SKILL env var is required')
    process.exit(1)
  }

  const result = await runAgent({ skill, args })

  if (!result.success) {
    console.error(`Agent failed: ${result.error}`)
    process.exit(1)
  }

  console.log(`Agent completed: ${result.turns} turns, ${result.tokensUsed} tokens, model: ${result.model}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
