import { randomUUID } from 'node:crypto'

export interface StoredMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface ChatSession {
  id: string
  createdAt: string
  messages: StoredMessage[]
}

/**
 * In-memory chat sessions, keyed by id. A restart forgets every session -- fine while this is
 * a scaffold; this is the seam to swap for a persistent store (e.g. MongoDB) later without
 * touching the routes in app.ts, which only see SessionStore's public methods.
 */
export class SessionStore {
  private sessions = new Map<string, ChatSession>()

  create(): ChatSession {
    const session: ChatSession = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      messages: [],
    }
    this.sessions.set(session.id, session)
    return session
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.get(id)
  }

  list(): ChatSession[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  appendMessage(id: string, message: StoredMessage): ChatSession | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    session.messages.push(message)
    return session
  }
}
