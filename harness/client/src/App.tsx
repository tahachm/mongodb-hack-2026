import { useEffect } from 'react'
import './App.css'
import { ChatWindow } from './ChatWindow'
import { Composer } from './Composer'
import { useChatStore } from './store'

function App() {
  const session = useChatStore((s) => s.session)
  const status = useChatStore((s) => s.status)
  const error = useChatStore((s) => s.error)
  const start = useChatStore((s) => s.start)
  const send = useChatStore((s) => s.send)

  // `start` is a stable zustand action identity, so this still only fires once on mount.
  useEffect(() => {
    start()
  }, [start])

  const busy = status === 'starting' || status === 'sending'

  return (
    <main className="app">
      <header className="app-header">
        <h1>AI Harness</h1>
        <button type="button" onClick={() => start()} disabled={busy}>
          New session
        </button>
      </header>

      {!session && status === 'starting' && <p className="status-line">Starting a session…</p>}

      {session && <ChatWindow messages={session.messages} />}

      {status === 'sending' && <p className="status-line">Agent is working…</p>}
      {status === 'error' && error && <p className="status-line status-error">{error}</p>}

      <Composer disabled={busy || !session} onSend={send} />
    </main>
  )
}

export default App
