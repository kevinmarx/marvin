import { bashExec } from './bash.js'
import type { ToolDefinition, ToolResult } from '../types.js'

const PROTECTED_BRANCHES = ['main', 'master']

function assertNotProtected(cwd?: string): ToolResult | null {
  const result = bashExec({
    command: 'git rev-parse --abbrev-ref HEAD',
    cwd,
    timeout: 5_000,
  })
  const branch = result.output.trim()

  if (PROTECTED_BRANCHES.includes(branch)) {
    return {
      output: '',
      error: `Refusing to write to protected branch "${branch}". Switch to a feature branch first.`,
    }
  }

  return null
}

// ─── Read-only operations ───────────────────────────────────────────

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description: 'Show working tree status (git status).',
  parameters: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: [],
  },
  execute: async (args) => {
    return bashExec({ command: 'git status', cwd: args.cwd as string | undefined })
  },
}

export const gitDiffTool: ToolDefinition = {
  name: 'git_diff',
  description: 'Show changes in working tree or between commits. Pass args like "--staged", "HEAD~3", etc.',
  parameters: {
    type: 'object',
    properties: {
      args: { type: 'string', description: 'Arguments to git diff (e.g. "--staged", "main...HEAD")' },
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: [],
  },
  execute: async (args) => {
    const diffArgs = args.args ? ` ${args.args}` : ''
    return bashExec({ command: `git diff${diffArgs}`, cwd: args.cwd as string | undefined })
  },
}

export const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description: 'Show commit log. Pass args like "--oneline -20", "main..HEAD", etc.',
  parameters: {
    type: 'object',
    properties: {
      args: { type: 'string', description: 'Arguments to git log (default: "--oneline -20")' },
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: [],
  },
  execute: async (args) => {
    const logArgs = (args.args as string) || '--oneline -20'
    return bashExec({ command: `git log ${logArgs}`, cwd: args.cwd as string | undefined })
  },
}

export const gitFetchTool: ToolDefinition = {
  name: 'git_fetch',
  description: 'Fetch from remote. Pass args like "origin main" or leave empty for default.',
  parameters: {
    type: 'object',
    properties: {
      args: { type: 'string', description: 'Arguments to git fetch (e.g. "origin main")' },
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: [],
  },
  execute: async (args) => {
    const fetchArgs = args.args ? ` ${args.args}` : ''
    return bashExec({ command: `git fetch${fetchArgs}`, cwd: args.cwd as string | undefined })
  },
}

// ─── Write operations (branch-safe) ────────────────────────────────

export const gitAddTool: ToolDefinition = {
  name: 'git_add',
  description: 'Stage files. Refuses to run on main/master.',
  parameters: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files to stage (prefer explicit paths over ".")',
      },
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: ['files'],
  },
  execute: async (args) => {
    const cwd = args.cwd as string | undefined
    const branchErr = assertNotProtected(cwd)
    if (branchErr) return branchErr

    const files = args.files as string[]
    const escaped = files.map((f) => `"${f}"`).join(' ')
    return bashExec({ command: `git add ${escaped}`, cwd })
  },
}

export const gitCommitTool: ToolDefinition = {
  name: 'git_commit',
  description: 'Create a commit. Refuses to run on main/master.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message' },
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: ['message'],
  },
  execute: async (args) => {
    const cwd = args.cwd as string | undefined
    const branchErr = assertNotProtected(cwd)
    if (branchErr) return branchErr

    const message = (args.message as string).replace(/'/g, "'\\''")
    return bashExec({ command: `git commit -m '${message}'`, cwd })
  },
}

export const gitPushTool: ToolDefinition = {
  name: 'git_push',
  description: 'Push to remote. Uses explicit refspec (HEAD:refs/heads/<branch>). Refuses to push to main/master.',
  parameters: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'Remote branch name to push to' },
      cwd: { type: 'string', description: 'Repository path' },
      force: { type: 'boolean', description: 'Force push (use with caution)' },
    },
    required: ['branch'],
  },
  execute: async (args) => {
    const cwd = args.cwd as string | undefined
    const branch = args.branch as string

    if (PROTECTED_BRANCHES.includes(branch)) {
      return {
        output: '',
        error: `Refusing to push to protected branch "${branch}".`,
      }
    }

    const branchErr = assertNotProtected(cwd)
    if (branchErr) return branchErr

    const forceFlag = args.force ? ' --force' : ''
    return bashExec({
      command: `git push origin HEAD:refs/heads/${branch}${forceFlag}`,
      cwd,
      timeout: 60_000,
    })
  },
}

export const gitCheckoutBranchTool: ToolDefinition = {
  name: 'git_checkout_branch',
  description: 'Switch to a branch or create a new one (-b flag).',
  parameters: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'Branch name' },
      create: { type: 'boolean', description: 'Create new branch (-b)' },
      start_point: { type: 'string', description: 'Start point for new branch (e.g. "origin/main")' },
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: ['branch'],
  },
  execute: async (args) => {
    const branch = args.branch as string
    const create = args.create as boolean | undefined
    const startPoint = args.start_point as string | undefined
    const cwd = args.cwd as string | undefined

    if (!branch || branch.trim().length === 0) {
      return { output: '', error: 'Branch name cannot be empty' }
    }

    let cmd = 'git checkout'
    if (create) cmd += ' -b'
    cmd += ` ${branch}`
    if (startPoint) cmd += ` ${startPoint}`

    return bashExec({ command: cmd, cwd })
  },
}
