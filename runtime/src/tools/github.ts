import { bashExec } from './bash.js'
import type { ToolDefinition } from '../types.js'

// ─── gh_pr_create ───────────────────────────────────────────────────

export const ghPrCreateTool: ToolDefinition = {
  name: 'gh_pr_create',
  description: 'Create a draft pull request using GitHub CLI.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'PR title' },
      body: { type: 'string', description: 'PR body (markdown)' },
      base: { type: 'string', description: 'Base branch (default: main)' },
      head: { type: 'string', description: 'Head branch (default: current branch)' },
      draft: { type: 'boolean', description: 'Create as draft (default: true)' },
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: ['title', 'body'],
  },
  execute: async (args) => {
    const title = (args.title as string).replace(/'/g, "'\\''")
    const body = (args.body as string).replace(/'/g, "'\\''")
    const base = (args.base as string) || 'main'
    const draft = args.draft !== false ? '--draft' : ''
    const headFlag = args.head ? `--head '${args.head}'` : ''

    const cmd = `gh pr create --title '${title}' --body '${body}' --base '${base}' ${draft} ${headFlag}`.trim()
    return bashExec({ command: cmd, cwd: args.cwd as string | undefined, timeout: 30_000 })
  },
}

// ─── gh_pr_list ─────────────────────────────────────────────────────

export const ghPrListTool: ToolDefinition = {
  name: 'gh_pr_list',
  description: 'List pull requests with optional filters.',
  parameters: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'], description: 'PR state filter (default: open)' },
      author: { type: 'string', description: 'Filter by author' },
      label: { type: 'string', description: 'Filter by label' },
      limit: { type: 'number', description: 'Max results (default: 30)' },
      json_fields: { type: 'string', description: 'Comma-separated JSON fields (e.g. "number,title,state,url")' },
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: [],
  },
  execute: async (args) => {
    const parts = ['gh pr list']
    if (args.state) parts.push(`--state ${args.state}`)
    if (args.author) parts.push(`--author '${args.author}'`)
    if (args.label) parts.push(`--label '${args.label}'`)
    if (args.limit) parts.push(`--limit ${args.limit}`)
    if (args.json_fields) parts.push(`--json ${args.json_fields}`)

    return bashExec({ command: parts.join(' '), cwd: args.cwd as string | undefined, timeout: 30_000 })
  },
}

// ─── gh_pr_view ─────────────────────────────────────────────────────

export const ghPrViewTool: ToolDefinition = {
  name: 'gh_pr_view',
  description: 'View pull request details.',
  parameters: {
    type: 'object',
    properties: {
      pr: { type: 'string', description: 'PR number, URL, or branch name' },
      json_fields: { type: 'string', description: 'Comma-separated JSON fields' },
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: ['pr'],
  },
  execute: async (args) => {
    const pr = args.pr as string
    const jsonFlag = args.json_fields ? ` --json ${args.json_fields}` : ''
    return bashExec({
      command: `gh pr view ${pr}${jsonFlag}`,
      cwd: args.cwd as string | undefined,
      timeout: 30_000,
    })
  },
}

// ─── gh_pr_diff ─────────────────────────────────────────────────────

export const ghPrDiffTool: ToolDefinition = {
  name: 'gh_pr_diff',
  description: 'Get the diff for a pull request.',
  parameters: {
    type: 'object',
    properties: {
      pr: { type: 'string', description: 'PR number, URL, or branch name' },
      cwd: { type: 'string', description: 'Repository path' },
    },
    required: ['pr'],
  },
  execute: async (args) => {
    return bashExec({
      command: `gh pr diff ${args.pr}`,
      cwd: args.cwd as string | undefined,
      timeout: 30_000,
    })
  },
}

// ─── gh_api ─────────────────────────────────────────────────────────

export const ghApiTool: ToolDefinition = {
  name: 'gh_api',
  description: 'Make a GitHub API call via gh CLI. For comment replies, thread resolution, check runs, etc.',
  parameters: {
    type: 'object',
    properties: {
      endpoint: { type: 'string', description: 'API endpoint (e.g. "repos/owner/repo/pulls/1/comments")' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default: GET)' },
      body: { type: 'string', description: 'JSON request body' },
      jq: { type: 'string', description: 'jq expression to filter output' },
    },
    required: ['endpoint'],
  },
  execute: async (args) => {
    const parts = ['gh api']
    const method = args.method as string | undefined

    if (method && method !== 'GET') parts.push(`--method ${method}`)

    const endpoint = args.endpoint as string
    parts.push(endpoint)

    if (args.body) {
      const body = (args.body as string).replace(/'/g, "'\\''")
      parts.push(`--input - <<< '${body}'`)
    }

    if (args.jq) parts.push(`--jq '${args.jq}'`)

    return bashExec({ command: parts.join(' '), timeout: 30_000 })
  },
}
