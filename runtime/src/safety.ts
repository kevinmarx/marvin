import { execSync } from 'node:child_process'
import path from 'node:path'
import type { ToolCall, SafetyCheck, SafetyContext, SafetyResult, MarvinConfig } from './types.js'
import type { StateManager } from './state.js'

// ─── Individual check factories ─────────────────────────────────────

function branchSafetyCheck(): SafetyCheck {
  return {
    name: 'branch-safety',
    async check(toolCall: ToolCall, context: SafetyContext): Promise<SafetyResult> {
      if (toolCall.function.name !== 'bash_exec') return { allowed: true }

      const args = parseToolArgs(toolCall)
      const command = args.command as string | undefined
      if (!command) return { allowed: true }

      const gitWriteOps = ['git commit', 'git push', 'git add', 'git merge', 'git rebase']
      const hasGitWrite = gitWriteOps.some(op => command.includes(op))
      if (!hasGitWrite) return { allowed: true }

      // Determine the working directory to check
      const checkPath = context.worktreePath ?? context.repoPath
      if (!checkPath) return { allowed: true }

      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: checkPath,
          encoding: 'utf-8',
          timeout: 5000,
        }).trim()

        if (branch === 'main' || branch === 'master') {
          return {
            allowed: false,
            reason: `Branch safety: refusing git write operation on '${branch}' in ${checkPath}`,
          }
        }
      } catch {
        // If we can't determine the branch, let it through — the git command
        // itself will fail if something is wrong
      }

      return { allowed: true }
    },
  }
}

function noForcePushCheck(): SafetyCheck {
  return {
    name: 'no-force-push',
    async check(toolCall: ToolCall, _context: SafetyContext): Promise<SafetyResult> {
      if (toolCall.function.name !== 'bash_exec') return { allowed: true }

      const args = parseToolArgs(toolCall)
      const command = args.command as string | undefined
      if (!command) return { allowed: true }

      if (!command.includes('git push')) return { allowed: true }

      // Only check force flags on git push commands
      // Allow --force-with-lease as it's a safe alternative
      if (/\s(--force|-f)(\s|$)/.test(command) && !command.includes('--force-with-lease')) {
        return {
          allowed: false,
          reason: 'Force push is not allowed. Use --force-with-lease if necessary.',
        }
      }

      return { allowed: true }
    },
  }
}

function noMainPushCheck(): SafetyCheck {
  return {
    name: 'no-main-push',
    async check(toolCall: ToolCall, _context: SafetyContext): Promise<SafetyResult> {
      if (toolCall.function.name !== 'bash_exec') return { allowed: true }

      const args = parseToolArgs(toolCall)
      const command = args.command as string | undefined
      if (!command) return { allowed: true }

      if (!command.includes('git push')) return { allowed: true }

      // Check if push targets main or master
      // Patterns: "git push origin main", "git push origin master",
      //   "HEAD:refs/heads/main", "HEAD:refs/heads/master"
      if (
        /git push\s+\S+\s+(main|master)\b/.test(command)
        || /refs\/heads\/(main|master)/.test(command)
      ) {
        return {
          allowed: false,
          reason: 'Pushing to main/master is not allowed. All changes must go through a feature branch.',
        }
      }

      return { allowed: true }
    },
  }
}

function concurrencyLimitCheck(stateManager: StateManager, config: MarvinConfig): SafetyCheck {
  return {
    name: 'concurrency-limit',
    async check(toolCall: ToolCall, _context: SafetyContext): Promise<SafetyResult> {
      // This check applies when spawning workers, not to arbitrary tool calls.
      if (toolCall.function.name !== 'spawn_worker') return { allowed: true }

      const running = stateManager.countRunningWorkers()
      const max = config.limits.max_concurrent_workers

      if (running >= max) {
        return {
          allowed: false,
          reason: `Concurrency limit: ${running}/${max} workers running. Cannot spawn more.`,
        }
      }

      return { allowed: true }
    },
  }
}

function noEnvReadsCheck(): SafetyCheck {
  return {
    name: 'no-env-reads',
    async check(toolCall: ToolCall, _context: SafetyContext): Promise<SafetyResult> {
      if (toolCall.function.name !== 'file_read') return { allowed: true }

      const args = parseToolArgs(toolCall)
      const filePath = args.path as string ?? args.file_path as string ?? ''
      const basename = path.basename(filePath)

      if (basename.startsWith('.env') || /\.env(\.|$)/.test(basename)) {
        return {
          allowed: false,
          reason: `Reading .env files is not allowed: ${filePath}`,
        }
      }

      return { allowed: true }
    },
  }
}

// ─── Public API ──────────────────────────────────────────────────────

export function createSafetyChecks(opts?: {
  stateManager?: StateManager
  config?: MarvinConfig
}): SafetyCheck[] {
  const { stateManager, config } = opts ?? {}
  const checks: SafetyCheck[] = [
    branchSafetyCheck(),
    noForcePushCheck(),
    noMainPushCheck(),
    noEnvReadsCheck(),
  ]

  if (stateManager && config) {
    checks.push(concurrencyLimitCheck(stateManager, config))
  }

  return checks
}

export async function runSafetyChecks(
  toolCall: ToolCall,
  checks: SafetyCheck[],
  context: SafetyContext,
): Promise<SafetyResult> {
  for (const check of checks) {
    const result = await check.check(toolCall, context)
    if (!result.allowed) {
      return result
    }
  }
  return { allowed: true }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(toolCall.function.arguments)
  } catch {
    return {}
  }
}
