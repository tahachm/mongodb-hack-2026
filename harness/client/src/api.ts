const BASE_URL = import.meta.env.VITE_HARNESS_SERVER_URL ?? 'http://localhost:4000'

// Mirrors harness-server's src/llm.ts and sessions.ts wire shapes. Duplicated rather than
// shared across the two processes -- same tradeoff as the merchant/psp mocks.
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result'
      id: string
      name: string
      output: unknown
      isError?: boolean
      durationMs?: number
    }

/** Timing and token usage of the model call behind an assistant turn (server TurnMetrics). */
export interface TurnMetrics {
  model: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  stopReason?: string
}

export interface StoredMessage {
  role: 'user' | 'assistant'
  content: ContentPart[]
  createdAt: string
  metrics?: TurnMetrics
}

/** GET /sessions/:id/inspect -- see harness-server's inspect.ts. */
export interface InspectAuditEvent {
  event_id: string
  run_id: string
  seq: number
  at: string
  type: string
  payload: Record<string, unknown>
}

export interface InspectRecord {
  purchase_id: string
  merchant_id: string | null
  notes: string
  product: Record<string, unknown> | null
  created: string | null
}

export interface InspectData {
  available: boolean
  events: InspectAuditEvent[]
  records: InspectRecord[]
}

export interface ChatSession {
  id: string
  createdAt: string
  messages: StoredMessage[]
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : JSON.stringify(body)
    throw new Error(message)
  }
  return body as T
}

export function createSession(): Promise<ChatSession> {
  return fetch(`${BASE_URL}/sessions`, { method: 'POST' }).then((res) => jsonOrThrow(res))
}

export function getSession(id: string): Promise<ChatSession> {
  return fetch(`${BASE_URL}/sessions/${id}`).then((res) => jsonOrThrow(res))
}

export function sendMessage(id: string, content: string): Promise<ChatSession> {
  return fetch(`${BASE_URL}/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }).then((res) => jsonOrThrow(res))
}

export function getInspectData(id: string): Promise<InspectData> {
  return fetch(`${BASE_URL}/sessions/${id}/inspect`).then((res) => jsonOrThrow(res))
}
