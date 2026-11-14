import { useEffect } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router'
import './App.css'
import { Background } from './Background'
import { ChatView } from './ChatView'
import { InspectView } from './InspectView'
import { Logo } from './Logo'
import { useChatStore } from './store'

function App() {
  const status = useChatStore((s) => s.status)
  const start = useChatStore((s) => s.start)

  // Started here, not in ChatView, so switching between views keeps the same conversation.
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
          <nav className="app-nav">
            <NavLink to="/" end className="app-nav-link">
              Chat
            </NavLink>
            <NavLink to="/inspect" className="app-nav-link">
              Inspect
            </NavLink>
            <button
              type="button"
              className="new-session-button"
              onClick={() => start()}
              disabled={busy}
            >
              New session
            </button>
          </nav>
        </header>

        <Routes>
          <Route path="/" element={<ChatView />} />
          <Route path="/inspect" element={<InspectView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  )
}

export default App
