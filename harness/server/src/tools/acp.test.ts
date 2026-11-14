import express, { type Express } from 'express'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAcpToolExecutor } from './acp.js'

function listen(app: Express): Promise<{ server: Server; url: string }> {
  const { promise, resolve } = Promise.withResolvers<{ server: Server; url: string }>()
  const server = app.listen(0, () => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    resolve({ server, url: `http://127.0.0.1:${address.port}` })
  })
  return promise
}

/** Fake merchant: just enough of the real ACP contract (see merchant/) to exercise the tool
 * executor -- products, create/get/complete/cancel checkout sessions. */
function fakeMerchant() {
  const app = express()
  app.use(express.json())
  const sessions = new Map<string, Record<string, unknown>>()

  app.get('/products', (req, res) => {
    const q = String(req.query.q ?? '')
    res.json({ products: q.includes('mouse') ? [{ id: 'm-1', name: 'Wireless Mouse' }] : [] })
  })

  app.post('/checkout_sessions', (req, res) => {
    const id = `cs_${sessions.size + 1}`
    const session = {
      id,
      status: 'ready_for_payment',
      currency: 'usd',
      line_items: req.body.items,
      totals: [{ type: 'total', amount: 2999 }],
    }
    sessions.set(id, session)
    res.status(201).json(session)
  })

  app.get('/checkout_sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id)
    if (!session) {
      res.status(404).json({ code: 'not_found' })
      return
    }
    res.json(session)
  })

  app.post('/checkout_sessions/:id/complete', (req, res) => {
    const session = sessions.get(req.params.id)
    if (!session) {
      res.status(404).json({ code: 'not_found' })
      return
    }
    session.status = 'completed'
    session.order = { id: 'ord_1' }
    res.json(session)
  })

  app.post('/checkout_sessions/:id/cancel', (req, res) => {
    const session = sessions.get(req.params.id)
    if (!session) {
      res.status(404).json({ code: 'not_found' })
      return
    }
    session.status = 'canceled'
    res.json(session)
  })

  return app
}

/** Fake PSP: always approves, echoing back the amount it was asked to delegate -- tests
 * assert on *that* to prove the executor reads the real total rather than trusting input. */
function fakePsp(seenAllowances: Array<Record<string, unknown>>) {
  const app = express()
  app.use(express.json())
  app.post('/agentic_commerce/delegate_payment', (req, res) => {
    seenAllowances.push(req.body.allowance)
    res.status(201).json({ id: 'vt_fake' })
  })
  return app
}

describe('createAcpToolExecutor', () => {
  let merchantServer: Server
  let pspServer: Server
  let merchantUrl: string
  let pspUrl: string
  let seenAllowances: Array<Record<string, unknown>>

  beforeEach(async () => {
    seenAllowances = []
    ;({ server: merchantServer, url: merchantUrl } = await listen(fakeMerchant()))
    ;({ server: pspServer, url: pspUrl } = await listen(fakePsp(seenAllowances)))
  })

  afterEach(() => {
    merchantServer.close()
    pspServer.close()
  })

  it('searches only the configured merchants and tags results by merchant_id', async () => {
    const execute = createAcpToolExecutor(new Map([['mall-wart', merchantUrl]]), pspUrl)
    const result = (await execute('search_products', { query: 'mouse' })) as {
      results: Array<{ merchant_id: string; products: unknown[] }>
    }
    expect(result.results).toEqual([
      { merchant_id: 'mall-wart', products: [{ id: 'm-1', name: 'Wireless Mouse' }] },
    ])
  })

  it('rejects an unknown merchant_id with the list of configured ones', async () => {
    const execute = createAcpToolExecutor(new Map([['mall-wart', merchantUrl]]), pspUrl)
    await expect(
      execute('get_checkout_session', { merchant_id: 'somefrills', session_id: 'cs_1' }),
    ).rejects.toThrow(/unknown merchant_id "somefrills".*mall-wart/)
  })

  it('creates and then fetches a checkout session', async () => {
    const execute = createAcpToolExecutor(new Map([['mall-wart', merchantUrl]]), pspUrl)
    const created = (await execute('create_checkout_session', {
      merchant_id: 'mall-wart',
      items: [{ id: 'm-1', quantity: 2 }],
    })) as { id: string; status: string }
    expect(created.status).toBe('ready_for_payment')

    const fetched = await execute('get_checkout_session', {
      merchant_id: 'mall-wart',
      session_id: created.id,
    })
    expect(fetched).toEqual(created)
  })

  it('pays using the session total read from the merchant, not an amount from input', async () => {
    const execute = createAcpToolExecutor(new Map([['mall-wart', merchantUrl]]), pspUrl)
    const created = (await execute('create_checkout_session', {
      merchant_id: 'mall-wart',
      items: [{ id: 'm-1', quantity: 1 }],
    })) as { id: string }

    const paid = (await execute('pay_for_checkout_session', {
      merchant_id: 'mall-wart',
      session_id: created.id,
      // An attacker-controlled or hallucinated amount here must be ignored entirely.
      amount: 1,
    })) as { status: string; order: { id: string } }

    expect(paid.status).toBe('completed')
    expect(paid.order.id).toBe('ord_1')
    expect(seenAllowances).toEqual([
      expect.objectContaining({
        max_amount: 2999,
        checkout_session_id: created.id,
        merchant_id: 'mall-wart',
      }),
    ])
  })

  it('cancels a checkout session', async () => {
    const execute = createAcpToolExecutor(new Map([['mall-wart', merchantUrl]]), pspUrl)
    const created = (await execute('create_checkout_session', {
      merchant_id: 'mall-wart',
      items: [{ id: 'm-1', quantity: 1 }],
    })) as { id: string }

    const canceled = (await execute('cancel_checkout_session', {
      merchant_id: 'mall-wart',
      session_id: created.id,
      reason: 'changed my mind',
    })) as { status: string }
    expect(canceled.status).toBe('canceled')
  })

  it('rejects search_products when no merchants are configured', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl)
    await expect(execute('search_products', { query: 'anything' })).rejects.toThrow(
      /no merchants configured/,
    )
  })
})
