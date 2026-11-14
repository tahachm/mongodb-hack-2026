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
      <button type="submit" disabled={disabled || value.trim() === ''}>
        Send
      </button>
    </form>
  )
}
