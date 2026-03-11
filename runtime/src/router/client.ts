import OpenAI from 'openai'
import type { Message, ToolCall, ToolDefinition, TokenUsage } from '../types.js'

// ─── Chat response ──────────────────────────────────────────────────

export interface ChatResponse {
  content: string | null
  toolCalls: ToolCall[]
  stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown'
  usage: TokenUsage
}

// ─── Client creation ────────────────────────────────────────────────

export function createClient(): OpenAI {
  const baseURL = process.env.LITELLM_BASE_URL
    ?? process.env.ANTHROPIC_BASE_URL

  const apiKey = process.env.LITELLM_API_KEY
    ?? process.env.ANTHROPIC_AUTH_TOKEN
    ?? 'no-key'

  if (!baseURL) {
    throw new Error(
      'LiteLLM proxy URL not configured. Set LITELLM_BASE_URL or ANTHROPIC_BASE_URL.'
    )
  }

  return new OpenAI({ baseURL, apiKey })
}

// ─── Singleton client ───────────────────────────────────────────────

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    _client = createClient()
  }
  return _client
}

// ─── Chat function ──────────────────────────────────────────────────

interface ChatOpts {
  model: string // litellm model string, e.g. 'anthropic/claude-opus-4'
  messages: Message[]
  tools?: ToolDefinition[]
  temperature?: number
}

export async function chat({ model, messages, tools, temperature }: ChatOpts): Promise<ChatResponse> {
  const client = getClient()

  const openaiMessages = messages.map(toOpenAIMessage)

  const openaiTools = tools?.length
    ? tools.map(toOpenAITool)
    : undefined

  try {
    const response = await client.chat.completions.create({
      model,
      messages: openaiMessages,
      tools: openaiTools,
      temperature: temperature ?? 0,
    })

    const choice = response.choices[0]
    if (!choice) {
      return {
        content: null,
        toolCalls: [],
        stopReason: 'unknown',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    }

    return {
      content: choice.message.content,
      toolCalls: extractToolCalls(choice.message),
      stopReason: mapFinishReason(choice.finish_reason),
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
    }
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      throw new Error(`LiteLLM API error (${error.status}): ${error.message}`)
    }
    throw error
  }
}

// ─── Message mapping ────────────────────────────────────────────────

type OpenAIMessage = OpenAI.ChatCompletionMessageParam

function toOpenAIMessage(msg: Message): OpenAIMessage {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      content: msg.content,
      tool_call_id: msg.tool_call_id ?? '',
    }
  }

  if (msg.role === 'assistant' && msg.tool_calls?.length) {
    return {
      role: 'assistant',
      content: msg.content || null,
      tool_calls: msg.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    }
  }

  if (msg.role === 'system') {
    return { role: 'system', content: msg.content }
  }

  if (msg.role === 'user') {
    return { role: 'user', content: msg.content }
  }

  // Assistant without tool_calls
  return { role: 'assistant', content: msg.content }
}

// ─── Tool mapping ───────────────────────────────────────────────────

function toOpenAITool(tool: ToolDefinition): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

// ─── Response extraction ────────────────────────────────────────────

function extractToolCalls(message: OpenAI.ChatCompletionMessage): ToolCall[] {
  if (!message.tool_calls?.length) return []

  return message.tool_calls.map(tc => ({
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  }))
}

function mapFinishReason(reason: string | null): ChatResponse['stopReason'] {
  switch (reason) {
    case 'stop': return 'stop'
    case 'tool_calls': return 'tool_calls'
    case 'length': return 'length'
    case 'content_filter': return 'content_filter'
    default: return 'unknown'
  }
}
