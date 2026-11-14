import Anthropic from '@anthropic-ai/sdk'
import type { ContentPart, LlmClient, LlmRequest, Turn } from './llm.js'

// `record_audit_event`'s tool-call JSON alone can run several hundred tokens (a
// recommendation_plan with 3 options and a handful of not_shown entries serializes to
// roughly 500-600 tokens), and the system prompt deliberately encourages issuing it in
// parallel with other tool calls in the same response. 1024 left too little headroom: a
// response that hit the cap mid tool-call produced truncated/invalid JSON, which
// parseHistoryInsights/parseRecommendationPlan then rejected outright -- forcing the model
// to regenerate the *entire* multi-hundred-token payload from scratch next turn. Default
// raised well above the largest payloads observed; overridable via ANTHROPIC_MAX_TOKENS for
// tuning without a code change.
export const DEFAULT_MAX_TOKENS = 4096

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

/** Claude truncates generation at `max_tokens` regardless of what it was mid-producing --
 * including inside a tool call's JSON. A truncated tool_use block fails validation in
 * acp.ts with a generic "must be a non-empty string"-style error that gives no hint this
 * was a token-budget problem, not a model mistake, costing a full extra turn to regenerate
 * the same payload. Surface it distinctly here instead, before that happens. */
function checkNotTruncated(stopReason: string | null, maxTokens: number): void {
  if (stopReason === 'max_tokens') {
    throw new Error(
      `Claude's response was cut off at max_tokens (${maxTokens}) while generating, ` +
        'likely mid tool call -- raise ANTHROPIC_MAX_TOKENS or shrink the payload being ' +
        'generated (e.g. fewer options/insights per record_audit_event call).',
    )
  }
}

export function createClaudeClient(
  apiKey: string,
  model: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): LlmClient {
  const anthropic = new Anthropic({ apiKey })

  return {
    async send({ system, messages, tools }: LlmRequest): Promise<Turn> {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
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
      checkNotTruncated(response.stop_reason, maxTokens)
      return { role: 'assistant', content: fromAnthropicContent(response.content) }
    },
  }
}
