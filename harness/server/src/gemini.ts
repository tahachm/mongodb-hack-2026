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
        return {
          functionCall: { id: part.id, name: part.name, args: part.input },
          // Gemini 3+ requires the thought signature from the original response to be
          // echoed back verbatim once this call is part of history, or the next request
          // is rejected outright -- see https://aistudio.google.com/docs/thought-signatures.
          ...(typeof part.providerMeta === 'string' ? { thoughtSignature: part.providerMeta } : {}),
        }
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

function fromGeminiParts(parts: Part[]): ContentPart[] {
  const content: ContentPart[] = []
  for (const part of parts) {
    if (part.text) {
      content.push({ type: 'text', text: part.text })
    } else if (part.functionCall) {
      content.push({
        type: 'tool_call',
        // Gemini doesn't always populate an id; synthesize one so our canonical shape
        // (which requires one) still round-trips correctly when we send the result back.
        id: part.functionCall.id ?? randomUUID(),
        name: part.functionCall.name ?? '',
        input: (part.functionCall.args as Record<string, unknown>) ?? {},
        providerMeta: part.thoughtSignature,
      })
    }
  }
  return content
}

export function createGeminiClient(apiKey: string, model: string): LlmClient {
  const ai = new GoogleGenAI({ apiKey })

  return {
    async send({ system, messages, tools }: LlmRequest): Promise<Turn> {
      const contents: Content[] = messages.map((turn) => ({
        role: toGeminiRole(turn.role),
        parts: toGeminiParts(turn.content),
      }))

      const started = performance.now()
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

      // Read parts straight off the candidate rather than the response.text/functionCalls
      // convenience getters -- those strip the per-part thoughtSignature we need to round-trip.
      const parts = response.candidates?.[0]?.content?.parts ?? []
      const usage = response.usageMetadata
      return {
        role: 'assistant',
        content: fromGeminiParts(parts),
        metrics: {
          model,
          durationMs: Math.round(performance.now() - started),
          inputTokens: usage?.promptTokenCount ?? 0,
          // Gemini counts thinking separately from the visible output; both are generated.
          outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
          cachedInputTokens: usage?.cachedContentTokenCount,
          stopReason: response.candidates?.[0]?.finishReason,
        },
      }
    },
  }
}
