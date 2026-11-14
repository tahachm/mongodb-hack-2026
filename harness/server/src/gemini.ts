import { GoogleGenAI, type Content, type Part } from '@google/genai'
import { randomUUID } from 'node:crypto'
import type { ContentPart, LlmClient, LlmRequest, Turn } from './llm.js'

function toGeminiRole(role: Turn['role']): 'user' | 'model' {
  // Gemini has no separate "assistant" role -- its own turns are 'model'.
  return role === 'assistant' ? 'model' : 'user'
}

function toGeminiParts(parts: ContentPart[]): Part[] {
  return parts.map((part): Part => {
    switch (part.type) {
      case 'text':
        return { text: part.text }
      case 'tool_call':
        return { functionCall: { id: part.id, name: part.name, args: part.input } }
      case 'tool_result':
        return {
          functionResponse: {
            id: part.id,
            name: part.name,
            response: part.isError ? { error: part.output } : { output: part.output },
          },
        }
    }
  })
}

export function createGeminiClient(apiKey: string, model: string): LlmClient {
  const ai = new GoogleGenAI({ apiKey })

  return {
    async send({ system, messages, tools }: LlmRequest): Promise<Turn> {
      const contents: Content[] = messages.map((turn) => ({
        role: toGeminiRole(turn.role),
        parts: toGeminiParts(turn.content),
      }))

      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: system,
          tools: tools.length
            ? [
                {
                  functionDeclarations: tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: tool.inputSchema,
                  })),
                },
              ]
            : undefined,
        },
      })

      const content: ContentPart[] = []
      if (response.text) content.push({ type: 'text', text: response.text })
      for (const call of response.functionCalls ?? []) {
        content.push({
          type: 'tool_call',
          // Gemini doesn't always populate an id; synthesize one so our canonical shape
          // (which requires one) still round-trips correctly when we send the result back.
          id: call.id ?? randomUUID(),
          name: call.name ?? '',
          input: (call.args as Record<string, unknown>) ?? {},
        })
      }
      return { role: 'assistant', content }
    },
  }
}
