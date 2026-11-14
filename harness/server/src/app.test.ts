import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { ChatTurn, LlmClient } from './llm.js'

function fakeLlm(reply: string | ((messages: ChatTurn[]) => string)): LlmClient {
  return {
    async send(messages) {
      return typeof reply === 'function' ? reply(messages) : reply
    },
  }
}

describe('harness-server chat API', () => {
  it('creates a session and lists it', async () => {
    const app = createApp(fakeLlm('hi'))
    const created = await request(app).post('/sessions').expect(201)
    expect(created.body.messages).toEqual([])

    const listed = await request(app).get('/sessions').expect(200)
    expect(listed.body.map((s: { id: string }) => s.id)).toContain(created.body.id)
  })

  it('404s for an unknown session', async () => {
    const app = createApp(fakeLlm('hi'))
    await request(app).get('/sessions/does-not-exist').expect(404)
  })

  it('appends the user message and the model reply, in order', async () => {
    const app = createApp(fakeLlm('pong'))
    const created = await request(app).post('/sessions').expect(201)

    const replied = await request(app)
      .post(`/sessions/${created.body.id}/messages`)
      .send({ content: 'ping' })
      .expect(200)

    expect(replied.body.messages).toHaveLength(2)
    expect(replied.body.messages[0]).toMatchObject({ role: 'user', content: 'ping' })
    expect(replied.body.messages[1]).toMatchObject({ role: 'assistant', content: 'pong' })
  })

  it('sends the full message history to the model on a follow-up turn', async () => {
    const seen: ChatTurn[][] = []
    const app = createApp(
      fakeLlm((messages) => {
        seen.push(messages)
        return `reply ${seen.length}`
      }),
    )
    const created = await request(app).post('/sessions').expect(201)
    await request(app)
      .post(`/sessions/${created.body.id}/messages`)
      .send({ content: 'first' })
      .expect(200)
    await request(app)
      .post(`/sessions/${created.body.id}/messages`)
      .send({ content: 'second' })
      .expect(200)

    expect(seen[1]).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'second' },
    ])
  })

  it('rejects an empty message body', async () => {
    const app = createApp(fakeLlm('hi'))
    const created = await request(app).post('/sessions').expect(201)
    await request(app)
      .post(`/sessions/${created.body.id}/messages`)
      .send({ content: '  ' })
      .expect(400)
  })

  it('returns 502 when the model provider fails, without losing the user turn', async () => {
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
      expect.objectContaining({ role: 'user', content: 'hello' }),
    ])
  })
})
