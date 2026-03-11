import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolDefinition, ToolResult } from '../types.js'

// ─── file_read ──────────────────────────────────────────────────────

interface FileReadOpts {
  file_path: string
  offset?: number
  limit?: number
}

function fileRead({ file_path, offset, limit }: FileReadOpts): ToolResult {
  try {
    const content = readFileSync(file_path, 'utf-8')
    const lines = content.split('\n')
    const startLine = offset ?? 0
    const endLine = limit ? startLine + limit : lines.length

    const numbered = lines
      .slice(startLine, endLine)
      .map((line, i) => `${String(startLine + i + 1).padStart(6)}\t${line}`)
      .join('\n')

    return { output: numbered }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: '', error: `Failed to read file: ${msg}` }
  }
}

export const fileReadTool: ToolDefinition = {
  name: 'file_read',
  description: 'Read a file and return contents with line numbers. Supports offset/limit for large files.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      offset: { type: 'number', description: 'Line number to start reading from (0-indexed)' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['file_path'],
  },
  execute: async (args) => {
    return fileRead({
      file_path: args.file_path as string,
      offset: args.offset as number | undefined,
      limit: args.limit as number | undefined,
    })
  },
}

// ─── file_write ─────────────────────────────────────────────────────

interface FileWriteOpts {
  file_path: string
  content: string
}

function fileWrite({ file_path, content }: FileWriteOpts): ToolResult {
  try {
    const dir = dirname(file_path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(file_path, content, 'utf-8')
    return { output: `Wrote ${content.length} bytes to ${file_path}` }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: '', error: `Failed to write file: ${msg}` }
  }
}

export const fileWriteTool: ToolDefinition = {
  name: 'file_write',
  description: 'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to write to' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['file_path', 'content'],
  },
  execute: async (args) => {
    return fileWrite({
      file_path: args.file_path as string,
      content: args.content as string,
    })
  },
}

// ─── file_edit ──────────────────────────────────────────────────────

interface FileEditOpts {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

function fileEdit({ file_path, old_string, new_string, replace_all }: FileEditOpts): ToolResult {
  try {
    const content = readFileSync(file_path, 'utf-8')

    if (old_string === new_string) {
      return { output: '', error: 'old_string and new_string are identical' }
    }

    if (!content.includes(old_string)) {
      return { output: '', error: 'old_string not found in file' }
    }

    if (replace_all) {
      const updated = content.replaceAll(old_string, new_string)
      writeFileSync(file_path, updated, 'utf-8')
      const count = content.split(old_string).length - 1
      return { output: `Replaced ${count} occurrence(s) in ${file_path}` }
    }

    // Check uniqueness
    const firstIdx = content.indexOf(old_string)
    const secondIdx = content.indexOf(old_string, firstIdx + 1)
    if (secondIdx !== -1) {
      return {
        output: '',
        error: 'old_string is not unique in the file. Provide more context or use replace_all.',
      }
    }

    const updated = content.replace(old_string, new_string)
    writeFileSync(file_path, updated, 'utf-8')
    return { output: `Edited ${file_path}` }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: '', error: `Failed to edit file: ${msg}` }
  }
}

export const fileEditTool: ToolDefinition = {
  name: 'file_edit',
  description: 'Search-and-replace in a file. old_string must be unique unless replace_all is true. Fails if old_string is not found.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      old_string: { type: 'string', description: 'Exact text to find' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  execute: async (args) => {
    return fileEdit({
      file_path: args.file_path as string,
      old_string: args.old_string as string,
      new_string: args.new_string as string,
      replace_all: args.replace_all as boolean | undefined,
    })
  },
}
