import { ChatWindow } from './ChatWindow'
import { Composer } from './Composer'
import { TypingIndicator } from './TypingIndicator'
import { useChatStore } from './store'

export function ChatView() {
  const session = useChatStore((s) => s.session)
  const status = useChatStore((s) => s.status)
  const error = useChatStore((s) => s.error)
  const send = useChatStore((s) => s.send)

  const busy = status === 'starting' || status === 'sending'

  return (
    <>
      {!session && status === 'starting' && <p className="status-line">Starting a session…</p>}

      {session && <ChatWindow messages={session.messages} />}

      {status === 'sending' && <TypingIndicator />}
      {status === 'error' && error && <p className="status-line status-error">{error}</p>}

      <Composer disabled={busy || !session} onSend={send} />
    </>
  )
}
