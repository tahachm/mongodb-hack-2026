import { GoogleGenAI } from '@google/genai'

/** Narrow seam between acp.ts and whichever embedding model is configured. Lets tests inject
 * a fake instead of making a real API call, same spirit as LlmClient in llm.ts. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
}

/** Embeds each text independently via Gemini's embedding API, in the order given. Embeddings
 * are a separate concern from chat (LLM_PROVIDER): Claude has no public embeddings API, so
 * this always goes through Gemini regardless of which provider is driving the conversation.
 *
 * `dimensions` is passed as `outputDimensionality` -- gemini-embedding-001 natively returns
 * 3072-dim vectors (via Matryoshka Representation Learning it supports truncating to shorter,
 * still-useful prefixes like 768 or 1536) and the preferences service's Atlas Vector Search
 * index is fixed-width, so this must match its `EMBEDDING_DIMENSIONS`.
 */
export function createGeminiEmbedder(apiKey: string, model: string, dimensions: number): Embedder {
  const ai = new GoogleGenAI({ apiKey })

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []
      const response = await ai.models.embedContent({
        model,
        contents: texts,
        config: { outputDimensionality: dimensions },
      })
      const embeddings = response.embeddings ?? []
      if (embeddings.length !== texts.length) {
        throw new Error(
          `embedContent returned ${embeddings.length} embeddings for ${texts.length} inputs`,
        )
      }
      return embeddings.map((embedding, i) => {
        if (!embedding.values) {
          throw new Error(`embedContent returned no values for input ${i}`)
        }
        return embedding.values
      })
    },
  }
}

/** Stands in for a real embedder when no embedding API key is configured, so the server can
 * still start and handle plain chat / non-purchase tools -- the error only surfaces the moment
 * something actually tries to pay (and therefore tries to record preferences). */
export function createUnavailableEmbedder(reason: string): Embedder {
  return {
    async embed(): Promise<number[][]> {
      throw new Error(reason)
    },
  }
}
