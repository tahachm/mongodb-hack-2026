import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
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

  it('dumps the full transcript (incl. decision + payment tool calls/results) to Mongo once a purchase completes', async () => {
    const checkoutOutput = {
      id: 'cs_1',
      merchant_id: 'mall-wart',
      status: 'completed',
      order: { id: 'order_1' },
      preference_tracking: { recorded: true },
    }
    const decisionOutput = {
      decisionId: 'dec_1',
      product: 'm-1',
      facts: [
        {
          sourceVectorSearch: 'search_products: "mouse"',
          response: 'a mouse',
          factImplication: 'matches',
        },
      ],
      result: 'pick m-1',
    }
    const recordPurchase = vi.fn().mockResolvedValue(undefined)
    const app = createApp(
      fakeLlm((history) => {
        const toolResultTurns = history.filter((turn) =>
          turn.content.some((part) => part.type === 'tool_result'),
        ).length
        if (toolResultTurns === 0) {
          return {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                id: 'call_decide',
                name: 'report_product_decision',
                input: {
                  product: 'm-1',
                  facts: decisionOutput.facts,
                  result: decisionOutput.result,
                },
              },
            ],
          }
        }
        if (toolResultTurns === 1) {
          return {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                id: 'call_pay',
                name: 'pay_for_checkout_session',
                input: { merchant_id: 'mall-wart', session_id: 'cs_1' },
              },
            ],
          }
        }
        return textTurn('all set')
      }),
      () => async (name) => (name === 'report_product_decision' ? decisionOutput : checkoutOutput),
      undefined,
      { recordPurchase, close: vi.fn() } as never,
    )

    const created = await request(app).post('/sessions').expect(201)
    const replied = await request(app)
      .post(`/sessions/${created.body.id}/messages`)
      .send({ content: 'buy it' })
      .expect(200)

    expect(recordPurchase).toHaveBeenCalledTimes(1)
    const [session, event] = recordPurchase.mock.calls[0]
    expect(session.id).toBe(created.body.id)
    expect(event).toEqual({
      merchantId: 'mall-wart',
      checkoutSessionId: 'cs_1',
      orderId: 'order_1',
    })
    // The dumped transcript is exactly what the buyer-facing response sees: every tool_call
    // request and tool_result response, not just the final text -- including the decision
    // event's own request/response, not only the payment's.
    expect(session.messages).toEqual(replied.body.messages)
    expect(session.messages.map((m: { content: { type: string }[] }) => m.content[0].type)).toEqual(
      ['text', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'text'],
    )
    const decisionCall = session.messages[1].content[0]
    expect(decisionCall).toMatchObject({ type: 'tool_call', name: 'report_product_decision' })
    const decisionResult = session.messages[2].content[0]
    expect(decisionResult).toMatchObject({
      type: 'tool_result',
      name: 'report_product_decision',
      output: decisionOutput,
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
