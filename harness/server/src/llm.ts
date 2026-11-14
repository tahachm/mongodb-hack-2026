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
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError?: boolean }

export interface Turn {
  role: 'user' | 'assistant'
  content: ContentPart[]
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
