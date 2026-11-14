import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { LlmClient, Turn } from './llm.js'

function fakeLlm(turns: Turn[] | ((history: Turn[]) => Turn)): LlmClient {
  let i = 0
  return {
    async send({ messages }) {
      if (typeof turns === 'function') return turns(messages)
      const turn = turns[i]
      i += 1
      if (!turn) throw new Error('fakeLlm ran out of scripted turns')
      return turn
    },
  }
}

function textTurn(text: string): Turn {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

describe('harness-server chat API', () => {
  it('creates a session and lists it', async () => {
    const app = createApp(fakeLlm([textTurn('hi')]))
    const created = await request(app).post('/sessions').expect(201)
    expect(created.body.messages).toEqual([])

    const listed = await request(app).get('/sessions').expect(200)
    expect(listed.body.map((s: { id: string }) => s.id)).toContain(created.body.id)
  })

  it('404s for an unknown session', async () => {
    const app = createApp(fakeLlm([textTurn('hi')]))
    await request(app).get('/sessions/does-not-exist').expect(404)
  })

  it('appends the user message and the final assistant text, in order', async () => {
    const app = createApp(fakeLlm([textTurn('pong')]))
    const created = await request(app).post('/sessions').expect(201)

    const replied = await request(app)
      .post(`/sessions/${created.body.id}/messages`)
      .send({ content: 'ping' })
      .expect(200)

    expect(replied.body.messages).toHaveLength(2)
    expect(replied.body.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'ping' }],
    })
    expect(replied.body.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
    })
  })

  it('executes a requested tool call and records every step before the final answer', async () => {
    const app = createApp(
      fakeLlm((history) => {
        const hasToolResult = history.some((turn) =>
          turn.content.some((part) => part.type === 'tool_result'),
        )
        if (hasToolResult) return textTurn('done searching')
        return {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'call_1', name: 'echo', input: { x: 1 } }],
        }
      }),
      () => async (name, input) => ({ sawName: name, sawInput: input }),
    )

    const created = await request(app).post('/sessions').expect(201)
    const replied = await request(app)
      .post(`/sessions/${created.body.id}/messages`)
      .send({ content: 'search for something' })
      .expect(200)

    const roles = replied.body.messages.map((m: { role: string }) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])

    const toolCallTurn = replied.body.messages[1]
    expect(toolCallTurn.content[0]).toMatchObject({ type: 'tool_call', id: 'call_1', name: 'echo' })

    const toolResultTurn = replied.body.messages[2]
    expect(toolResultTurn.content[0]).toMatchObject({
      type: 'tool_result',
      id: 'call_1',
      name: 'echo',
      output: { sawName: 'echo', sawInput: { x: 1 } },
    })

    expect(replied.body.messages[3]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done searching' }],
    })
  })

  it('rejects an empty message body', async () => {
    const app = createApp(fakeLlm([textTurn('hi')]))
    const created = await request(app).post('/sessions').expect(201)
    await request(app)
      .post(`/sessions/${created.body.id}/messages`)
      .send({ content: '  ' })
      .expect(400)
  })

  it('returns 502 when the model provider fails, keeping whatever already completed', async () => {
    const app = createApp({
      async send() {
        throw new Error('rate limited')
      },
    })
    const created = await request(app).post('/sessions').expect(201)
    await request(app)
      .post(`/sessions/${created.body.id}/messages`)
      .send({ content: 'hello' })
      .expect(502)

    const session = await request(app).get(`/sessions/${created.body.id}`).expect(200)
    expect(session.body.messages).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'hello' }] }),
    ])
  })
})
