import { useState, type FormEvent } from 'react'

export function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean
  onSend: (content: string) => void
}) {
  const [value, setValue] = useState('')

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const trimmed = value.trim()
    if (trimmed === '' || disabled) return
    onSend(trimmed)
    setValue('')
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Ask the agent to find or buy something..."
        disabled={disabled}
        autoFocus
      />
      <button type="submit" className="send-button" disabled={disabled || value.trim() === ''}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M1 8 L15 8 M9 2 L15 8 L9 14"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Send
      </button>
    </form>
  )
}
