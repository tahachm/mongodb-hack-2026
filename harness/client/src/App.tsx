import { useEffect } from 'react'
import './App.css'
import { Background } from './Background'
import { ChatWindow } from './ChatWindow'
import { Composer } from './Composer'
import { Logo } from './Logo'
import { TypingIndicator } from './TypingIndicator'
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
    <>
      <Background />
      <main className="app">
        <header className="app-header">
          <div className="app-brand">
            <Logo />
            <div>
              <h1>AI Harness</h1>
              <p className="app-tagline">Agentic shopping, demoed live</p>
            </div>
          </div>
          <button
            type="button"
            className="new-session-button"
            onClick={() => start()}
            disabled={busy}
          >
            New session
          </button>
        </header>

        {!session && status === 'starting' && <p className="status-line">Starting a session…</p>}

        {session && <ChatWindow messages={session.messages} />}

        {status === 'sending' && <TypingIndicator />}
        {status === 'error' && error && <p className="status-line status-error">{error}</p>}

        <Composer disabled={busy || !session} onSend={send} />
      </main>
    </>
  )
}

export default App
