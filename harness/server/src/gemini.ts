import { GoogleGenAI } from '@google/genai'
import type { LlmClient } from './llm.js'

export function createGeminiClient(apiKey: string, model: string): LlmClient {
  const ai = new GoogleGenAI({ apiKey })

  return {
    async send(messages) {
      // Gemini has no separate "assistant" role -- its own turns are 'model'.
      const contents = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))
      const response = await ai.models.generateContent({ model, contents })
      return response.text ?? ''
    },
  }
}
