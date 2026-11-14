import { useEffect, useRef } from 'react'
import type { StoredMessage } from './api'
import { MarkdownText } from './MarkdownText'
import { TypingIndicator } from './TypingIndicator'

export function ChatWindow({
  messages,
  pending,
}: {
  messages: StoredMessage[]
  pending: boolean
}) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, pending])

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
              <MarkdownText key={j} text={part.text} />
            ))}
          </div>
        )
      })}
      {pending && (
        <div className="message message-assistant message-pending">
          <TypingIndicator />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
