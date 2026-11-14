import { create } from 'zustand'
import { createSession, sendMessage, type ChatSession } from './api'

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
    set({ status: 'sending', error: null })
    try {
      const updated = await sendMessage(session.id, content)
      set({ session: updated, status: 'idle' })
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },
}))
