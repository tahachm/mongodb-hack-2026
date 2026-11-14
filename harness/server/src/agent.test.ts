import { describe, expect, it } from 'vitest'
import { runAgentTurn } from './agent.js'
import type { LlmClient, Turn } from './llm.js'

function fakeLlm(script: (history: Turn[], callIndex: number) => Turn): LlmClient {
  let i = 0
  return {
    async send({ messages }) {
      const turn = script(messages, i)
      i += 1
      return turn
    },
  }
}

describe('runAgentTurn', () => {
  it('returns immediately on a plain text reply, with no tool execution', async () => {
    const llm = fakeLlm(() => ({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }))
    const seen: Turn[] = []
    let executed = false
    await runAgentTurn(
      llm,
      'system',
      [],
      [],
      async () => {
        executed = true
        return {}
      },
      (turn) => seen.push(turn),
    )

    expect(executed).toBe(false)
    expect(seen).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('executes a tool call, feeds the result back, and continues to a final answer', async () => {
    const llm = fakeLlm((_history, i) => {
      if (i === 0) {
        return {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c1', name: 'search', input: { q: 'mouse' } }],
        }
      }
      return { role: 'assistant', content: [{ type: 'text', text: 'found it' }] }
    })

    const calls: Array<{ name: string; input: Record<string, unknown> }> = []
    const seen: Turn[] = []
    await runAgentTurn(
      llm,
      'system',
      [],
      [],
      async (name, input) => {
        calls.push({ name, input })
        return { ok: true }
      },
      (turn) => seen.push(turn),
    )

    expect(calls).toEqual([{ name: 'search', input: { q: 'mouse' } }])
    expect(seen).toHaveLength(3)
    expect(seen[0]).toMatchObject({ role: 'assistant', content: [{ type: 'tool_call', id: 'c1' }] })
    expect(seen[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', id: 'c1', name: 'search', output: { ok: true } }],
    })
    expect(seen[2]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'found it' }],
    })
  })

  it('turns a tool executor throw into an error tool_result instead of failing the turn', async () => {
    const llm = fakeLlm((_history, i) => {
      if (i === 0) {
        return {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c1', name: 'boom', input: {} }],
        }
      }
      return { role: 'assistant', content: [{ type: 'text', text: 'ok, handled the error' }] }
    })

    const seen: Turn[] = []
    await runAgentTurn(
      llm,
      'system',
      [],
      [],
      async () => {
        throw new Error('merchant unreachable')
      },
      (turn) => seen.push(turn),
    )

    expect(seen[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          id: 'c1',
          name: 'boom',
          output: 'merchant unreachable',
          isError: true,
        },
      ],
    })
  })

  it('executes multiple tool calls from one turn and matches each result back by id', async () => {
    const llm = fakeLlm((_history, i) => {
      if (i === 0) {
        return {
          role: 'assistant',
          content: [
            { type: 'tool_call', id: 'a', name: 'f', input: { n: 1 } },
            { type: 'tool_call', id: 'b', name: 'f', input: { n: 2 } },
          ],
        }
      }
      return { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
    })

    const seen: Turn[] = []
    await runAgentTurn(
      llm,
      'system',
      [],
      [],
      async (_name, input) => ({ doubled: (input.n as number) * 2 }),
      (turn) => seen.push(turn),
    )

    const resultTurn = seen[1]
    expect(resultTurn.content).toEqual([
      { type: 'tool_result', id: 'a', name: 'f', output: { doubled: 2 } },
      { type: 'tool_result', id: 'b', name: 'f', output: { doubled: 4 } },
    ])
  })

  it('gives up after too many tool-call iterations instead of looping forever', async () => {
    const llm = fakeLlm(() => ({
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'loop', name: 'again', input: {} }],
    }))

    const seen: Turn[] = []
    await runAgentTurn(
      llm,
      'system',
      [],
      [],
      async () => ({}),
      (turn) => seen.push(turn),
    )

    const last = seen[seen.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content[0]).toMatchObject({ type: 'text' })
    // Bounded: an assistant turn + a tool-result turn per iteration, capped, plus the give-up
    // message -- this just needs to be small and constant, not grow without bound.
    expect(seen.length).toBeLessThan(20)
  })
})
