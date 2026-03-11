import type { ToolDefinition, ToolResult } from '../types.js'

const LINEAR_API_URL = 'https://linear.app/api/graphql'

function getApiKey(): string {
  const key = process.env.LINEAR_API_KEY
  if (!key) throw new Error('LINEAR_API_KEY environment variable is not set')
  return key
}

async function linearQuery(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getApiKey(),
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!resp.ok) {
    throw new Error(`Linear API error: ${resp.status} ${resp.statusText}`)
  }

  const json = await resp.json() as { data?: unknown; errors?: Array<{ message: string }> }

  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`)
  }

  return json.data
}

// ─── linear_list_issues ─────────────────────────────────────────────

export interface ListIssuesOpts {
  team?: string
  assignee?: string
  state?: string
  label?: string
  limit?: number
}

export async function linearListIssues(opts: ListIssuesOpts): Promise<ToolResult> {
  try {
    const limit = opts.limit ?? 50

    // Build filter object for GraphQL variables (avoids string interpolation injection)
    const filter: Record<string, unknown> = {}
    if (opts.team) filter.team = { name: { eq: opts.team } }
    if (opts.assignee) filter.assignee = { name: { eq: opts.assignee } }
    if (opts.state) filter.state = { type: { eq: opts.state } }
    if (opts.label) filter.labels = { name: { eq: opts.label } }

    const hasFilter = Object.keys(filter).length > 0

    const data = await linearQuery(`
      query($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter, orderBy: updatedAt) {
          nodes {
            id
            identifier
            title
            state { name type }
            assignee { name email }
            labels { nodes { name } }
            priority
            createdAt
            updatedAt
          }
        }
      }
    `, {
      first: limit,
      filter: hasFilter ? filter : undefined,
    }) as { issues: { nodes: unknown[] } }

    return { output: JSON.stringify(data.issues.nodes, null, 2) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: '', error: `Failed to list issues: ${msg}` }
  }
}

export const linearListIssuesTool: ToolDefinition = {
  name: 'linear_list_issues',
  description: 'List Linear issues with filters (team, assignee, state type, label).',
  parameters: {
    type: 'object',
    properties: {
      team: { type: 'string', description: 'Filter by team name' },
      assignee: { type: 'string', description: 'Filter by assignee name' },
      state: { type: 'string', description: 'Filter by state type (triage, backlog, unstarted, started, completed, canceled)' },
      label: { type: 'string', description: 'Filter by label name' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
    required: [],
  },
  execute: async (args) => {
    return linearListIssues({
      team: args.team as string | undefined,
      assignee: args.assignee as string | undefined,
      state: args.state as string | undefined,
      label: args.label as string | undefined,
      limit: args.limit as number | undefined,
    })
  },
}

// ─── linear_get_issue ───────────────────────────────────────────────

export async function linearGetIssue(id: string): Promise<ToolResult> {
  try {
    const data = await linearQuery(`
      query($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          state { name type }
          assignee { id name email }
          labels { nodes { name } }
          priority
          priorityLabel
          estimate
          parent { id identifier title }
          children { nodes { id identifier title state { name } } }
          comments { nodes { id body user { name } createdAt } }
          createdAt
          updatedAt
        }
      }
    `, { id }) as { issue: unknown }

    return { output: JSON.stringify(data.issue, null, 2) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: '', error: `Failed to get issue: ${msg}` }
  }
}

export const linearGetIssueTool: ToolDefinition = {
  name: 'linear_get_issue',
  description: 'Get detailed information about a Linear issue by ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Issue ID (UUID or identifier like TEAM-123)' },
    },
    required: ['id'],
  },
  execute: async (args) => {
    return linearGetIssue(args.id as string)
  },
}

// ─── linear_update_issue ────────────────────────────────────────────

interface UpdateIssueOpts {
  id: string
  state_id?: string
  assignee_id?: string
  title?: string
  description?: string
  priority?: number
  label_ids?: string[]
}

export async function linearUpdateIssue(opts: UpdateIssueOpts): Promise<ToolResult> {
  try {
    const input: Record<string, unknown> = {}
    if (opts.state_id) input.stateId = opts.state_id
    if (opts.assignee_id) input.assigneeId = opts.assignee_id
    if (opts.title) input.title = opts.title
    if (opts.description !== undefined) input.description = opts.description
    if (opts.priority !== undefined) input.priority = opts.priority
    if (opts.label_ids) input.labelIds = opts.label_ids

    const data = await linearQuery(`
      mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
            identifier
            title
            state { name }
            assignee { name }
          }
        }
      }
    `, { id: opts.id, input }) as { issueUpdate: { success: boolean; issue: unknown } }

    if (!data.issueUpdate.success) {
      return { output: '', error: 'Issue update returned success: false' }
    }

    return { output: JSON.stringify(data.issueUpdate.issue, null, 2) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: '', error: `Failed to update issue: ${msg}` }
  }
}

export const linearUpdateIssueTool: ToolDefinition = {
  name: 'linear_update_issue',
  description: 'Update a Linear issue (state, assignee, title, description, priority, labels).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Issue ID (UUID)' },
      state_id: { type: 'string', description: 'New state ID' },
      assignee_id: { type: 'string', description: 'New assignee ID (null to unassign)' },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New description (markdown)' },
      priority: { type: 'number', description: '0=None, 1=Urgent, 2=High, 3=Normal, 4=Low' },
      label_ids: { type: 'array', items: { type: 'string' }, description: 'Label IDs to set' },
    },
    required: ['id'],
  },
  execute: async (args) => {
    return linearUpdateIssue({
      id: args.id as string,
      state_id: args.state_id as string | undefined,
      assignee_id: args.assignee_id as string | undefined,
      title: args.title as string | undefined,
      description: args.description as string | undefined,
      priority: args.priority as number | undefined,
      label_ids: args.label_ids as string[] | undefined,
    })
  },
}

// ─── linear_create_comment ──────────────────────────────────────────

interface CreateCommentOpts {
  issue_id: string
  body: string
}

export async function linearCreateComment({ issue_id, body }: CreateCommentOpts): Promise<ToolResult> {
  try {
    const data = await linearQuery(`
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id
            body
            createdAt
          }
        }
      }
    `, { issueId: issue_id, body }) as {
      commentCreate: { success: boolean; comment: unknown }
    }

    if (!data.commentCreate.success) {
      return { output: '', error: 'Comment creation returned success: false' }
    }

    return { output: JSON.stringify(data.commentCreate.comment, null, 2) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: '', error: `Failed to create comment: ${msg}` }
  }
}

export const linearCreateCommentTool: ToolDefinition = {
  name: 'linear_create_comment',
  description: 'Create a comment on a Linear issue.',
  parameters: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Issue ID (UUID)' },
      body: { type: 'string', description: 'Comment body (markdown)' },
    },
    required: ['issue_id', 'body'],
  },
  execute: async (args) => {
    return linearCreateComment({
      issue_id: args.issue_id as string,
      body: args.body as string,
    })
  },
}

// ─── linear_list_users ──────────────────────────────────────────────

export async function linearListUsers(filter?: string): Promise<ToolResult> {
  try {
    const userFilter = filter ? { name: { contains: filter } } : undefined

    const data = await linearQuery(`
      query($first: Int!, $filter: UserFilter) {
        users(first: $first, filter: $filter) {
          nodes {
            id
            name
            email
            active
          }
        }
      }
    `, {
      first: 100,
      filter: userFilter,
    }) as { users: { nodes: unknown[] } }

    return { output: JSON.stringify(data.users.nodes, null, 2) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: '', error: `Failed to list users: ${msg}` }
  }
}

export const linearListUsersTool: ToolDefinition = {
  name: 'linear_list_users',
  description: 'List Linear workspace users. Optionally filter by name.',
  parameters: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: 'Filter users by name (contains match)' },
    },
    required: [],
  },
  execute: async (args) => {
    return linearListUsers(args.filter as string | undefined)
  },
}
