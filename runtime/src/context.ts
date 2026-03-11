import type { Message } from './types.js'

const CHARS_PER_TOKEN = 4

export function estimateTokens(messages: Message[]): number {
  let totalChars = 0
  for (const msg of messages) {
    totalChars += msg.content.length
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        totalChars += tc.function.name.length + tc.function.arguments.length
      }
    }
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN)
}

export function truncateToolResult(result: string, maxChars = 30000): string {
  if (result.length <= maxChars) return result

  const truncated = result.length - maxChars
  return result.slice(0, maxChars) + `\n...(truncated ${truncated} chars)`
}

export function compactMessages(messages: Message[], maxTokens: number): Message[] {
  if (estimateTokens(messages) <= maxTokens) return messages

  // Always keep the system message (first)
  const systemMessages = messages.filter(m => m.role === 'system')
  const nonSystemMessages = messages.filter(m => m.role !== 'system')

  // Always keep the last 10 non-system messages
  const keepTailCount = Math.min(10, nonSystemMessages.length)
  const tail = nonSystemMessages.slice(-keepTailCount)
  const older = nonSystemMessages.slice(0, -keepTailCount)

  // Phase 1: Truncate tool results in older messages
  const compactedOlder = older.map(msg => {
    if (msg.role === 'tool' && msg.content.length > 200) {
      return { ...msg, content: msg.content.slice(0, 200) + '...(truncated)' }
    }
    return msg
  })

  let result = [...systemMessages, ...compactedOlder, ...tail]
  if (estimateTokens(result) <= maxTokens) return result

  // Phase 2: Drop oldest assistant+tool pairs from the compacted older section
  // Work backwards through the older section, removing pairs until we fit
  const mutableOlder = [...compactedOlder]
  while (mutableOlder.length > 0 && estimateTokens([...systemMessages, ...mutableOlder, ...tail]) > maxTokens) {
    // Remove the oldest message. If it's an assistant with tool_calls,
    // also remove the following tool response(s)
    const removed = mutableOlder.shift()!
    if (removed.role === 'assistant' && removed.tool_calls && removed.tool_calls.length > 0) {
      // Remove corresponding tool responses
      while (mutableOlder.length > 0 && mutableOlder[0].role === 'tool') {
        mutableOlder.shift()
      }
    }
  }

  result = [...systemMessages, ...mutableOlder, ...tail]
  return result
}
