/** Minimal JSON Schema subset both Claude's `input_schema` and Gemini's
 * `parametersJsonSchema` accept directly, with no per-provider translation needed. */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
}

/**
 * One piece of a turn's content. `tool_call` only ever appears in an `assistant` turn (the
 * model asking to invoke a tool); `tool_result` only ever appears in a `user` turn (the
 * result fed back to the model) -- this is the convention both Claude and Gemini use for
 * tool results, so the canonical shape here maps onto either with no role juggling.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      input: Record<string, unknown>
      /** Opaque data a provider needs echoed back verbatim when this tool_call is replayed
       * in a later request (e.g. Gemini's thought signatures). Other providers ignore it. */
      providerMeta?: unknown
    }
  | {
      type: 'tool_result'
      id: string
      name: string
      output: unknown
      isError?: boolean
      /** How long the tool itself took to run, for inspection only. */
      durationMs?: number
    }

/** Timing and token usage of the single model call that produced an assistant turn. For
 * inspection only -- never sent back to the model (providers map content parts explicitly). */
export interface TurnMetrics {
  model: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  /** Input tokens served from the provider's prompt cache, when it reports them. */
  cachedInputTokens?: number
  /** Why generation stopped, e.g. end_turn, tool_use, max_tokens. */
  stopReason?: string
}

export interface Turn {
  role: 'user' | 'assistant'
  content: ContentPart[]
  metrics?: TurnMetrics
}

export interface LlmRequest {
  system: string
  messages: Turn[]
  tools: ToolDefinition[]
}

/** Narrow seam between app.ts/agent.ts and whichever model provider is configured. Lets
 * tests inject a fake instead of making real API calls, and lets index.ts pick a provider
 * (Gemini, Claude, ...) without the rest of the server knowing it exists. */
export interface LlmClient {
  send(request: LlmRequest): Promise<Turn>
}
