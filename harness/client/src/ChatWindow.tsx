import { useEffect, useRef } from 'react'
import type { StoredMessage } from './api'

export function ChatWindow({ messages }: { messages: StoredMessage[] }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="chat-window">
      {messages.map((message, i) => {
        const textParts = message.content.filter((part) => part.type === 'text')
        // Tool calls/results are plumbing, not something the human said or should see --
        // skip the row entirely when a turn has no text (e.g. a pure tool_result turn).
        if (textParts.length === 0) return null

        return (
          <div key={i} className={`message message-${message.role}`}>
            {textParts.map((part, j) => (
              <p key={j} className="message-text">
                {part.text}
              </p>
            ))}
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
