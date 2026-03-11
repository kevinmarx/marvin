import type { ToolCall, ToolResult, ToolDefinition } from '../types.js'

// ─── Tool imports ───────────────────────────────────────────────────

import { bashExecTool } from './bash.js'
import { fileReadTool, fileWriteTool, fileEditTool } from './file.js'
import { globSearchTool, grepSearchTool } from './search.js'
import {
  gitStatusTool, gitDiffTool, gitLogTool, gitFetchTool,
  gitAddTool, gitCommitTool, gitPushTool, gitCheckoutBranchTool,
} from './git.js'
import {
  ghPrCreateTool, ghPrListTool, ghPrViewTool, ghPrDiffTool, ghApiTool,
} from './github.js'
import {
  linearListIssuesTool, linearGetIssueTool, linearUpdateIssueTool,
  linearCreateCommentTool, linearListUsersTool,
} from './linear.js'

// ─── Registry ───────────────────────────────────────────────────────

const ALL_TOOLS: ToolDefinition[] = [
  // File operations
  fileReadTool,
  fileWriteTool,
  fileEditTool,

  // Search
  globSearchTool,
  grepSearchTool,

  // Bash
  bashExecTool,

  // Git
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitFetchTool,
  gitAddTool,
  gitCommitTool,
  gitPushTool,
  gitCheckoutBranchTool,

  // GitHub
  ghPrCreateTool,
  ghPrListTool,
  ghPrViewTool,
  ghPrDiffTool,
  ghApiTool,

  // Linear
  linearListIssuesTool,
  linearGetIssueTool,
  linearUpdateIssueTool,
  linearCreateCommentTool,
  linearListUsersTool,
]

const toolMap = new Map<string, ToolDefinition>(
  ALL_TOOLS.map((t) => [t.name, t])
)

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Execute a tool call from the model's response.
 * Parses the arguments JSON and dispatches to the tool's execute function.
 */
export async function executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
  const { name, arguments: argsJson } = toolCall.function

  const tool = toolMap.get(name)
  if (!tool) {
    return { output: '', error: `Unknown tool: ${name}` }
  }

  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson)
  } catch {
    return { output: '', error: `Invalid JSON arguments for tool ${name}: ${argsJson}` }
  }

  try {
    return await tool.execute(args)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: '', error: `Tool ${name} threw: ${msg}` }
  }
}

/**
 * Get tool definitions for the model.
 * Optionally filter to a subset of tool names.
 * The chat client handles converting these to OpenAI format.
 */
export function getToolDefinitions(filter?: string[]): ToolDefinition[] {
  if (!filter) return ALL_TOOLS
  return ALL_TOOLS.filter((t) => filter.includes(t.name))
}

/**
 * Get a tool definition by name.
 */
export function getTool(name: string): ToolDefinition | undefined {
  return toolMap.get(name)
}

/**
 * List all registered tool names.
 */
export function getToolNames(): string[] {
  return ALL_TOOLS.map((t) => t.name)
}
