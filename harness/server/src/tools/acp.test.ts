import express, { type Express } from 'express'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext('buyer_42'),
    )
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
    // Recording preferences is a separate tool call now -- paying never touches /purchases.
    expect(seenPurchases).toEqual([])
  })

  it('cancels a checkout session', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
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

  it('records a history_insights audit event, returning a generated event_id and seq', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    const result = (await execute('record_audit_event', {
      type: 'history_insights',
      updates_event_id: null,
      request: 'A comfortable hoodie. No size, colour, budget or occasion given.',
      insights: [
        {
          facet: 'size',
          finding: "Wears size M in sweatshirts; said 'M' when buying one in September.",
          evidence: ['pur_3a91c0d2e4f5a6b7c8d9'],
          confidence: 'high',
        },
      ],
      ignored_records: [],
      gaps: [
        {
          facet: 'comfort',
          important: false,
          action: 'skip',
          note: 'No history on what comfortable means to them.',
        },
      ],
      assumptions: ['No budget limit; show a spread of prices.'],
      follow_up_question: null,
      summary: 'They want a comfortable hoodie; history shows size M and dark colours.',
    })) as { event_id: string; seq: number }

    expect(result.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(result.seq).toBe(1)
  })

  it('records a recommendation_plan audit event, and seq increases across calls on the same executor', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await execute('record_audit_event', {
      type: 'history_insights',
      updates_event_id: null,
      request: 'req',
      insights: [],
      ignored_records: [],
      gaps: [],
      assumptions: [],
      follow_up_question: null,
      summary: 'summary',
    })
    const result = (await execute('record_audit_event', {
      type: 'recommendation_plan',
      insights_event_id: 'evt_6d2e91a4c07b',
      searches: ['hoodie', 'hooded'],
      options: [
        {
          option_number: 1,
          product_id: 'clothing-03469',
          merchant_ids: ['threadbarn'],
          price_cents: 1079,
          why: 'Black, size M, lowest price.',
          insights_used: ['colour', 'size'],
          unknowns: ['material'],
          tradeoff: 'Same colour as one they already have.',
        },
      ],
      highlighted_product_id: 'clothing-03469',
      highlight_reason: 'Matches settled preferences at the lowest price.',
      not_shown: [{ product_id: 'clothing-03360', reason: 'Black like option 1 but pricier.' }],
      assumptions_relied_on: ['No budget limit; show a spread of prices.'],
      no_fit_explanation: null,
      summary: 'One hooded sweatshirt in size M, led by the cheapest black one.',
    })) as { event_id: string; seq: number }

    expect(result.seq).toBe(2)
  })

  it('rejects record_audit_event with an unknown type', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(execute('record_audit_event', { type: 'something_else' })).rejects.toThrow(
      /"type" must be one of: history_insights, recommendation_plan/,
    )
  })

  it('rejects history_insights with a bad confidence value, naming which insight', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(
      execute('record_audit_event', {
        type: 'history_insights',
        updates_event_id: null,
        request: 'req',
        insights: [{ facet: 'size', finding: 'f', evidence: [], confidence: 'certain' }],
        ignored_records: [],
        gaps: [],
        assumptions: [],
        follow_up_question: null,
        summary: 'summary',
      }),
    ).rejects.toThrow(/insights\[0\]: "confidence" must be one of: high, medium, low/)
  })

  it('rejects recommendation_plan missing a required option field', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(
      execute('record_audit_event', {
        type: 'recommendation_plan',
        insights_event_id: 'evt_1',
        searches: ['hoodie'],
        options: [{ option_number: 1, product_id: 'p-1' }],
        highlighted_product_id: null,
        highlight_reason: null,
        not_shown: [],
        assumptions_relied_on: [],
        no_fit_explanation: null,
        summary: 'summary',
      }),
    ).rejects.toThrow(/options\[0\]: "merchant_ids" must be an array of strings/)
  })

  it('rejects search_products when no merchants are configured', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(execute('search_products', { query: 'anything' })).rejects.toThrow(
      /no merchants configured/,
    )
  })

  it('searches preferences with structured queries, scoping to buyer_id', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext('buyer_42'),
    )

    const result = (await execute('search_preferences', {
      queries: [
        { id: 'toilet paper', text: 'The user mentions wanting toilet paper', limit: 3 },
        { id: 'something unrelated', text: 'something unrelated' },
      ],
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
          { id: 'toilet paper', text: 'The user mentions wanting toilet paper', limit: 3 },
          { id: 'something unrelated', text: 'something unrelated' },
        ],
      }),
    ])
  })

  it('passes merchant_id through to search_preferences when given', async () => {
    const execute = createAcpToolExecutor(
      new Map([['mall-wart', merchantUrl]]),
      pspUrl,
      preferencesContext(),
    )
    await execute('search_preferences', {
      queries: [{ id: 'toilet paper', text: 'toilet paper' }],
      merchant_id: 'mall-wart',
    })
    expect(seenSearches).toEqual([expect.objectContaining({ merchant_id: 'mall-wart' })])
  })

  it('rejects search_preferences without any queries', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(execute('search_preferences', { queries: [] })).rejects.toThrow(
      /"queries" must be a non-empty array/,
    )
  })

  it('saves a purchased preference record, building notes and one vector per narrative field', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext('buyer_42'))
    const product = { id: 'clothing-03491', name: 'Thread Barn Hooded Sweatshirt, M, Heather Gray' }

    const result = (await execute('save_preference_record', {
      kind: 'purchased',
      request: "The user asked: 'I want a comfortable hoodie'.",
      comparison: 'The assistant showed three hooded sweatshirts in size M.',
      decision:
        'The user chose the heather gray one. They said the black ones look too similar to one they own.',
      merchant_id: 'threadbarn',
      product,
      options_shown: [
        { merchant_id: 'threadbarn', product_id: 'clothing-03469' },
        { merchant_id: 'threadbarn', product_id: 'clothing-03491' },
      ],
    })) as { purchase_id: string; vector_count: number }

    expect(result).toEqual(expect.objectContaining({ purchase_id: 'pur_fake', vector_count: 3 }))
    expect(seenPurchases).toEqual([
      {
        buyer_id: 'buyer_42',
        merchant_id: 'threadbarn',
        product,
        notes:
          'Kind: purchased\n' +
          "Request: The user asked: 'I want a comfortable hoodie'.\n" +
          'Options shown: The assistant showed three hooded sweatshirts in size M.\n' +
          'Decision: The user chose the heather gray one. They said the black ones look too ' +
          'similar to one they own.\n' +
          'Option ids: threadbarn/clothing-03469, threadbarn/clothing-03491',
        vectors: [
          { label: 'request', text: "The user asked: 'I want a comfortable hoodie'." },
          { label: 'comparison', text: 'The assistant showed three hooded sweatshirts in size M.' },
          {
            label: 'decision',
            text:
              'The user chose the heather gray one. They said the black ones look too similar ' +
              'to one they own.',
          },
        ],
      },
    ])
  })

  it('saves a stated_preference record with an empty comparison and null product as {}', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await execute('save_preference_record', {
      kind: 'stated_preference',
      request: "The user said: 'I've gone vegetarian.'",
      comparison: '',
      decision: 'n/a',
      merchant_id: null,
      product: null,
      options_shown: [],
    })
    expect(seenPurchases).toEqual([
      expect.objectContaining({
        merchant_id: null,
        product: {},
        // No vector for the empty comparison field -- only request and decision.
        vectors: [
          { label: 'request', text: "The user said: 'I've gone vegetarian.'" },
          { label: 'decision', text: 'n/a' },
        ],
      }),
    ])
  })

  it('rejects save_preference_record with an unknown kind', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(
      execute('save_preference_record', {
        kind: 'bought_it',
        request: 'r',
        comparison: '',
        decision: 'd',
        merchant_id: null,
        product: null,
        options_shown: [],
      }),
    ).rejects.toThrow(
      /"kind" must be one of: purchased, selected, rejected_all, no_decision, stated_preference/,
    )
  })

  it('rejects save_preference_record missing a required field', async () => {
    const execute = createAcpToolExecutor(new Map(), pspUrl, preferencesContext())
    await expect(
      execute('save_preference_record', {
        kind: 'no_decision',
        request: 'r',
        comparison: '',
        decision: 'd',
        merchant_id: null,
        product: null,
      }),
    ).rejects.toThrow(/"options_shown" must be an array of objects/)
  })
})
