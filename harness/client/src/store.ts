import { create } from 'zustand'
import { createSession, sendMessage, type ChatSession, type StoredMessage } from './api'

export type ChatStatus = 'idle' | 'starting' | 'sending' | 'error'

interface ChatState {
  session: ChatSession | null
  status: ChatStatus
  error: string | null
  start: () => Promise<void>
  send: (content: string) => Promise<void>
}

export const useChatStore = create<ChatState>((set, get) => ({
  session: null,
  status: 'idle',
  error: null,

  async start() {
    set({ status: 'starting', error: null })
    try {
      const session = await createSession()
      set({ session, status: 'idle' })
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  async send(content) {
    const { session } = get()
    if (!session) return
    // Show the user's own message the instant they send it -- the server round trip (the
    // model call, any tool calls) can take a while, and the message is already real: app.ts
    // persists it before doing anything else, so it's never lost even if the rest fails.
    // `session` is replaced wholesale once the response arrives (not appended to), so this
    // optimistic copy is superseded by the server's own record of it, not duplicated.
    const optimisticMessage: StoredMessage = {
      role: 'user',
      content: [{ type: 'text', text: content }],
      createdAt: new Date().toISOString(),
    }
    set({
      session: { ...session, messages: [...session.messages, optimisticMessage] },
      status: 'sending',
      error: null,
    })
    try {
      const updated = await sendMessage(session.id, content)
      set({ session: updated, status: 'idle' })
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },
}))
