import Anthropic from '@anthropic-ai/sdk'
import type { LlmClient } from './llm.js'

const MAX_TOKENS = 1024

export function createClaudeClient(apiKey: string, model: string): LlmClient {
  const anthropic = new Anthropic({ apiKey })

  return {
    async send(messages) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        messages,
      })
      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      )
      return textBlock?.text ?? ''
    },
  }
}
