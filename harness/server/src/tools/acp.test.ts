import express, { type Express } from 'express'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolExecutor } from '../agent.js'
import { createAcpToolExecutor, type PreferencesContext } from './acp.js'

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

/** Fake preferences store: just enough of the real contract (see preferences/) to exercise
 * the tool executor -- records whatever it's POSTed and echoes back an id. */
function fakePreferences(
  seenPurchases: Array<Record<string, unknown>>,
  seenSearches: Array<Record<string, unknown>> = [],
) {
  const app = express()
  app.use(express.json())
  app.post('/purchases', (req, res) => {
    seenPurchases.push(req.body)
    res.status(201).json({
      purchase_id: 'pur_fake',
      created: new Date().toISOString(),
      vector_count: (req.body.vectors ?? []).length,
    })
  })
  app.post('/purchases/search', (req, res) => {
    seenSearches.push(req.body)
    const queries = (req.body.queries ?? []) as Array<{ id: string }>
    res.json({
      results: queries.map((q) => ({
        id: q.id,
        // Only a query literally asking about toilet paper gets a canned match -- lets
        // tests tell "found a relevant prior purchase" apart from "found nothing" using
        // the same fake server, same spirit as fakeMerchant's "mouse" products filter.
        matches:
          q.id === 'toilet paper'
            ? [
                {
                  purchase_id: 'pur_prior',
                  label: 'prefers unscented',
                  score: 0.95,
                  merchant_id: 'mall-wart',
                  product: { line_items: [{ title: 'EcoSoft Toilet Paper, 12-pack' }] },
                  notes: 'User mentioned preferring unscented toilet paper.',
                  created: '2026-01-01T00:00:00.000Z',
                },
              ]
            : [],
      })),
    })
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
  let preferencesServer: Server
  let merchantUrl: string
  let pspUrl: string
  let preferencesUrl: string
  let seenAllowances: Array<Record<string, unknown>>
  let seenPurchases: Array<Record<string, unknown>>
  let seenSearches: Array<Record<string, unknown>>

  function preferencesContext(buyerId = 'buyer_1'): PreferencesContext {
    return { baseUrl: preferencesUrl, buyerId }
  }

  /** Satisfies create_checkout_session's report_product_decision gate for `product` so tests
   * about checkout/payment/cancel, not about the gate itself, don't have to restate it. */
  async function reportDecision(execute: ToolExecutor, product = 'm-1') {
    await execute('report_product_decision', {
      product,
      facts: [
        {
          sourceVectorSearch: 'search_products: "wireless mouse"',
          response: 'Wireless Mouse, $29.99, in stock',
          factImplication: 'Matches what the buyer asked for and is available.',
        },
      ],
      result: `Selecting ${product}: it matches the request.`,
    })
  }

  beforeEach(async () => {
    seenAllowances = []
    seenPurchases = []
    seenSearches = []
    ;({ server: merchantServer, url: merchantUrl } = await listen(fakeMerchant()))
    ;({ server: pspServer, url: pspUrl } = await listen(fakePsp(seenAllowances)))
    ;({ server: preferencesServer, url: preferencesUrl } = await listen(
      fakePreferences(seenPurchases, seenSearches),
    ))
  })

  afterEach(() => {
    merchantServer.close()
    pspServer.close()
    preferencesServer.close()
  })

  it('searches only the configured merchants and tags results by merchant_id', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    const result = (await execute('search_products', { query: 'mouse' })) as {
      results: Array<{ merchant_id: string; products: unknown[] }>
    }
    expect(result.results).toEqual([
      { merchant_id: 'mall-wart', products: [{ id: 'm-1', name: 'Wireless Mouse' }] },
    ])
  })

  it('rejects an unknown merchant_id with the list of configured ones', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    await expect(
      execute('get_checkout_session', { merchant_id: 'somefrills', session_id: 'cs_1' }),
    ).rejects.toThrow(/unknown merchant_id "somefrills".*mall-wart/)
  })

  it('creates and then fetches a checkout session', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    await reportDecision(execute)
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

  it('pays using the session total read from the merchant, not an amount from input, and records preferences', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext('buyer_42'),
    )
    await reportDecision(execute)
    const created = (await execute('create_checkout_session', {
      merchant_id: 'mall-wart',
      items: [{ id: 'm-1', quantity: 1 }],
    })) as { id: string }

    const paid = (await execute('pay_for_checkout_session', {
      merchant_id: 'mall-wart',
      session_id: created.id,
      // An attacker-controlled or hallucinated amount here must be ignored entirely.
      amount: 1,
      preference_notes: ['bought for a lakeside picnic', 'leans toward budget options'],
      conversation_notes: 'User wanted something for an upcoming picnic, price-sensitive.',
    })) as {
      status: string
      order: { id: string }
      preference_tracking: { recorded: boolean; purchase_id?: string; vector_count?: number }
    }

    expect(paid.status).toBe('completed')
    expect(paid.order.id).toBe('ord_1')
    expect(seenAllowances).toEqual([
      expect.objectContaining({
        max_amount: 2999,
        checkout_session_id: created.id,
        merchant_id: 'mall-wart',
      }),
    ])

    expect(paid.preference_tracking).toEqual({
      recorded: true,
      purchase_id: 'pur_fake',
      vector_count: 2,
    })
    expect(seenPurchases).toEqual([
      expect.objectContaining({
        buyer_id: 'buyer_42',
        merchant_id: 'mall-wart',
        notes: 'User wanted something for an upcoming picnic, price-sensitive.',
        vectors: [
          { label: 'bought for a lakeside picnic', text: 'bought for a lakeside picnic' },
          { label: 'leans toward budget options', text: 'leans toward budget options' },
        ],
      }),
    ])
  })

  it('rejects pay_for_checkout_session without preference_notes', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    await reportDecision(execute)
    const created = (await execute('create_checkout_session', {
      merchant_id: 'mall-wart',
      items: [{ id: 'm-1', quantity: 1 }],
    })) as { id: string }

    await expect(
      execute('pay_for_checkout_session', {
        merchant_id: 'mall-wart',
        session_id: created.id,
        conversation_notes: 'some notes',
      }),
    ).rejects.toThrow(/"preference_notes" must be a non-empty array/)
    expect(seenAllowances).toEqual([]) // no money moved
  })

  it('rejects pay_for_checkout_session without conversation_notes', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    await reportDecision(execute)
    const created = (await execute('create_checkout_session', {
      merchant_id: 'mall-wart',
      items: [{ id: 'm-1', quantity: 1 }],
    })) as { id: string }

    await expect(
      execute('pay_for_checkout_session', {
        merchant_id: 'mall-wart',
        session_id: created.id,
        preference_notes: ['likes blue'],
      }),
    ).rejects.toThrow(/"conversation_notes" must be a non-empty string/)
    expect(seenAllowances).toEqual([]) // no money moved
  })

  it('completes the purchase even if recording preferences fails, and reports it', async () => {
    preferencesServer.close()
    const brokenPreferences = express()
    brokenPreferences.use(express.json())
    brokenPreferences.post('/purchases', (_req, res) =>
      res.status(500).json({ message: 'db down' }),
    )
    ;({ server: preferencesServer, url: preferencesUrl } = await listen(brokenPreferences))

    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    await reportDecision(execute)
    const created = (await execute('create_checkout_session', {
      merchant_id: 'mall-wart',
      items: [{ id: 'm-1', quantity: 1 }],
    })) as { id: string }

    const paid = (await execute('pay_for_checkout_session', {
      merchant_id: 'mall-wart',
      session_id: created.id,
      preference_notes: ['likes blue'],
      conversation_notes: 'some notes',
    })) as {
      status: string
      preference_tracking: { recorded: boolean; error?: string }
    }

    // The charge still went through -- a tracking outage must never look like a failed
    // purchase or trigger a retry (which would double-charge).
    expect(paid.status).toBe('completed')
    expect(seenAllowances).toHaveLength(1)
    expect(paid.preference_tracking.recorded).toBe(false)
    expect(paid.preference_tracking.error).toMatch(/500/)
  })

  it('cancels a checkout session', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    await reportDecision(execute)
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

  it('rejects create_checkout_session for an item with no reported decision', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    await expect(
      execute('create_checkout_session', {
        merchant_id: 'mall-wart',
        items: [{ id: 'm-1', quantity: 1 }],
      }),
    ).rejects.toThrow(/report_product_decision must be called.*missing for: m-1/)
  })

  it('accepts create_checkout_session once a decision was reported for every item, in an earlier call', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    // Simulates the decision being reported in an earlier message of the same conversation --
    // the executor is reused for the whole session (see app.ts), so this must still count.
    await reportDecision(execute)
    const created = (await execute('create_checkout_session', {
      merchant_id: 'mall-wart',
      items: [{ id: 'm-1', quantity: 1 }],
    })) as { status: string }
    expect(created.status).toBe('ready_for_payment')
  })

  it('records a product decision with a server-generated decisionId, echoing the input back', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    const facts = [
      {
        sourceVectorSearch: 'recall_past_purchases: "mouse"',
        response: 'Bought a wired mouse last year, noted "prefers wireless next time"',
        factImplication: 'Buyer wants wireless this time.',
      },
    ]
    const decision = (await execute('report_product_decision', {
      product: 'm-1',
      facts,
      result: 'm-1 is wireless and matches the stated preference.',
    })) as { decisionId: string; product: string; facts: unknown[]; result: string }

    expect(decision.decisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(decision.product).toBe('m-1')
    expect(decision.facts).toEqual(facts)
    expect(decision.result).toBe('m-1 is wireless and matches the stated preference.')
  })

  it('rejects report_product_decision without any facts', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(
      execute('report_product_decision', { product: 'm-1', facts: [], result: 'because' }),
    ).rejects.toThrow(/"facts" must be a non-empty array/)
  })

  it('rejects report_product_decision when a fact is missing a required field', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(
      execute('report_product_decision', {
        product: 'm-1',
        facts: [{ sourceVectorSearch: 'search_products: "mouse"', response: 'a mouse' }],
        result: 'because',
      }),
    ).rejects.toThrow(/facts\[0\]\.factImplication must be a non-empty string/)
  })

  it('rejects search_products when no merchants are configured', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(execute('search_products', { query: 'anything' })).rejects.toThrow(
      /no merchants configured/,
    )
  })

  it('recalls a relevant past purchase by querying with raw text, scoping to buyer_id', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext('buyer_42'),
    )

    const result = (await execute('recall_past_purchases', {
      queries: ['toilet paper', 'something unrelated'],
    })) as { results: Array<{ id: string; matches: Array<Record<string, unknown>> }> }

    expect(result.results).toEqual([
      {
        id: 'toilet paper',
        matches: [
          expect.objectContaining({
            purchase_id: 'pur_prior',
            notes: 'User mentioned preferring unscented toilet paper.',
          }),
        ],
      },
      { id: 'something unrelated', matches: [] },
    ])

    expect(seenSearches).toEqual([
      expect.objectContaining({
        buyer_id: 'buyer_42',
        queries: [
          { id: 'toilet paper', text: 'toilet paper' },
          { id: 'something unrelated', text: 'something unrelated' },
        ],
      }),
    ])
  })

  it('passes merchant_id through to recall_past_purchases when given', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    await execute('recall_past_purchases', { queries: ['toilet paper'], merchant_id: 'mall-wart' })
    expect(seenSearches).toEqual([expect.objectContaining({ merchant_id: 'mall-wart' })])
  })

  it('rejects recall_past_purchases without any queries', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(execute('recall_past_purchases', { queries: [] })).rejects.toThrow(
      /"queries" must be a non-empty array/,
    )
  })
})
