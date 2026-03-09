import { statSync } from 'node:fs'
import { glob } from 'glob'
import { bashExec } from './bash.js'
import type { ToolDefinition, ToolResult } from '../types.js'

// ─── glob_search ────────────────────────────────────────────────────

interface GlobSearchOpts {
  pattern: string
  path?: string
}

async function globSearch({ pattern, path }: GlobSearchOpts): Promise<ToolResult> {
  try {
    const cwd = path ?? process.cwd()
    const matches = await glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
      dot: false,
    })

    // Sort by modification time, most recent first
    const withMtime = matches.map((filePath) => {
      try {
        const stat = statSync(filePath)
        return { filePath, mtime: stat.mtimeMs }
      } catch {
        return { filePath, mtime: 0 }
      }
    })
    withMtime.sort((a, b) => b.mtime - a.mtime)

    const result = withMtime.map((f) => f.filePath).join('\n')
    return { output: result || 'No files matched.' }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: '', error: `Glob search failed: ${msg}` }
  }
}

export const globSearchTool: ToolDefinition = {
  name: 'glob_search',
  description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.go"). Returns paths sorted by modification time (newest first).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match files' },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
    },
    required: ['pattern'],
  },
  execute: async (args) => {
    return globSearch({
      pattern: args.pattern as string,
      path: args.path as string | undefined,
    })
  },
}

// ─── grep_search ────────────────────────────────────────────────────

type GrepOutputMode = 'content' | 'files_with_matches' | 'count'

interface GrepSearchOpts {
  pattern: string
  path?: string
  glob_filter?: string
  context?: number
  output_mode?: GrepOutputMode
  case_insensitive?: boolean
}

function grepSearch(opts: GrepSearchOpts): ToolResult {
  const { pattern, path, glob_filter, context, output_mode, case_insensitive } = opts
  const searchPath = path ?? '.'

  // Try ripgrep first, fall back to grep
  const rgArgs: string[] = ['rg']

  if (case_insensitive) rgArgs.push('-i')

  switch (output_mode) {
    case 'files_with_matches':
      rgArgs.push('-l')
      break
    case 'count':
      rgArgs.push('-c')
      break
    default:
      // content mode
      rgArgs.push('-n') // line numbers
      if (context && context > 0) {
        rgArgs.push('-C', String(context))
      }
  }

  if (glob_filter) {
    rgArgs.push('--glob', glob_filter)
  }

  rgArgs.push('--', pattern, searchPath)

  const cmd = rgArgs.map(shellEscape).join(' ')
  const result = bashExec({ command: cmd, timeout: 30_000 })

  // rg exits with code 1 for "no matches" — that's not an error
  if (result.error && result.output === '') {
    // Check if rg is available
    const check = bashExec({ command: 'which rg', timeout: 5_000 })
    if (check.error) {
      return grepFallback(opts)
    }
    return { output: 'No matches found.' }
  }

  // Exit code 1 = no matches but rg ran fine
  if (result.error && result.output) {
    return { output: result.output }
  }

  return result
}

function grepFallback(opts: GrepSearchOpts): ToolResult {
  const { pattern, path, glob_filter, context, output_mode, case_insensitive } = opts
  const searchPath = path ?? '.'

  const grepArgs: string[] = ['grep', '-r']

  if (case_insensitive) grepArgs.push('-i')

  switch (output_mode) {
    case 'files_with_matches':
      grepArgs.push('-l')
      break
    case 'count':
      grepArgs.push('-c')
      break
    default:
      grepArgs.push('-n')
      if (context && context > 0) {
        grepArgs.push('-C', String(context))
      }
  }

  if (glob_filter) {
    grepArgs.push('--include', glob_filter)
  }

  grepArgs.push('-E', pattern, searchPath)

  const cmd = grepArgs.map(shellEscape).join(' ')
  const result = bashExec({ command: cmd, timeout: 30_000 })

  if (result.error && result.output === '') {
    return { output: 'No matches found.' }
  }

  if (result.error && result.output) {
    return { output: result.output }
  }

  return result
}

function shellEscape(arg: string): string {
  if (/^[a-zA-Z0-9._\-/=:*]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, "'\\''")}'`
}

export const grepSearchTool: ToolDefinition = {
  name: 'grep_search',
  description: 'Search file contents with regex (uses ripgrep). Supports context lines, file filtering, and output modes (content/files_with_matches/count).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search (default: cwd)' },
      glob_filter: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")' },
      context: { type: 'number', description: 'Number of context lines before and after each match' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output mode (default: content)',
      },
      case_insensitive: { type: 'boolean', description: 'Case insensitive search (default false)' },
    },
    required: ['pattern'],
  },
  execute: async (args) => {
    return grepSearch({
      pattern: args.pattern as string,
      path: args.path as string | undefined,
      glob_filter: args.glob_filter as string | undefined,
      context: args.context as number | undefined,
      output_mode: args.output_mode as GrepOutputMode | undefined,
      case_insensitive: args.case_insensitive as boolean | undefined,
    })
  },
}
