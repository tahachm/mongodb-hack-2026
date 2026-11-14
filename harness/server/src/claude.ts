import Anthropic from '@anthropic-ai/sdk'
import type { ContentPart, LlmClient, LlmRequest, Turn } from './llm.js'

// record_audit_event calls carry a lot of structured JSON; at 1024 they were routinely cut
// off mid-call, arriving with missing fields and forcing a retry.
const MAX_TOKENS = 4096

function toAnthropicContent(parts: ContentPart[]): Anthropic.ContentBlockParam[] {
  return parts.map((part): Anthropic.ContentBlockParam => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text }
      case 'tool_call':
        return { type: 'tool_use', id: part.id, name: part.name, input: part.input }
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: part.id,
          content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
          is_error: part.isError,
        }
    }
  })
}

function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): ContentPart[] {
  const parts: ContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use') {
      parts.push({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      })
    }
    // Other block types (thinking, server tool use, ...) are intentionally ignored --
    // out of scope for this simple harness.
  }
  return parts
}

export function createClaudeClient(apiKey: string, model: string): LlmClient {
  const anthropic = new Anthropic({ apiKey })

  return {
    async send({ system, messages, tools }: LlmRequest): Promise<Turn> {
      const response = await anthropic.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: messages.map((turn) => ({
          role: turn.role,
          content: toAnthropicContent(turn.content),
        })),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        })),
      })
      return { role: 'assistant', content: fromAnthropicContent(response.content) }
    },
  }
}
