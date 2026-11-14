import Anthropic from '@anthropic-ai/sdk'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** Narrow seam between app.ts's routes and the Anthropic SDK -- lets tests inject a fake
 * instead of making real API calls. */
export interface ClaudeClient {
  send(messages: ChatTurn[]): Promise<string>
}

const MAX_TOKENS = 1024

export function createClaudeClient(apiKey: string, model: string): ClaudeClient {
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
