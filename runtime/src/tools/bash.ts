import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process'
import { statSync } from 'node:fs'
import type { ToolDefinition, ToolResult } from '../types.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 100_000

interface BashExecOpts {
  command: string
  cwd?: string
  timeout?: number
}

export function bashExec({ command, cwd, timeout }: BashExecOpts): ToolResult {
  const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

  const opts: ExecSyncOptionsWithStringEncoding = {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: '/bin/bash',
  }

  if (cwd) {
    try {
      const stat = statSync(cwd)
      if (!stat.isDirectory()) {
        return { output: '', error: `cwd is not a directory: ${cwd}` }
      }
    } catch {
      return { output: '', error: `cwd does not exist: ${cwd}` }
    }
    opts.cwd = cwd
  }

  try {
    const stdout = execSync(command, opts)
    const output = truncate(stdout)
    return { output }
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; status?: number; message?: string }
    const stdout = (execErr.stdout ?? '').toString()
    const stderr = (execErr.stderr ?? '').toString()
    const exitCode = execErr.status ?? 1

    const combined = [stdout, stderr].filter(Boolean).join('\n')
    return {
      output: truncate(combined),
      error: `Command exited with code ${exitCode}`,
    }
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(0, MAX_OUTPUT_CHARS) + '\n... (output truncated)'
}

export const bashExecTool: ToolDefinition = {
  name: 'bash_exec',
  description: 'Execute a bash command. Returns stdout/stderr. Default timeout 120s, max 600s.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000)' },
    },
    required: ['command'],
  },
  execute: async (args) => {
    return bashExec({
      command: args.command as string,
      cwd: args.cwd as string | undefined,
      timeout: args.timeout as number | undefined,
    })
  },
}
