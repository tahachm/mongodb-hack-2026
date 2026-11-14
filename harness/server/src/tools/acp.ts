import { randomUUID } from 'node:crypto'
import type { ToolExecutor } from '../agent.js'
import type { Embedder } from '../embeddings.js'
import type { ToolDefinition } from '../llm.js'

export const acpTools: ToolDefinition[] = [
  {
    name: 'search_products',
    description:
      "Search every configured merchant's catalog for products matching a query. " +
      'Returns matches grouped by merchant_id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search text, e.g. "wireless mouse"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_checkout_session',
    description:
      'Start a checkout session with one merchant for a list of items. Returns the ' +
      'session id, priced line items, and totals.',
    inputSchema: {
      type: 'object',
      properties: {
        merchant_id: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'catalog item id, from search_products' },
              quantity: { type: 'integer', minimum: 1 },
            },
            required: ['id'],
          },
        },
      },
      required: ['merchant_id', 'items'],
    },
  },
  {
    name: 'get_checkout_session',
    description:
      "Fetch a checkout session's current state: status, line items, totals, and the " +
      'order if it has been completed.',
    inputSchema: {
      type: 'object',
      properties: {
        merchant_id: { type: 'string' },
        session_id: { type: 'string' },
      },
      required: ['merchant_id', 'session_id'],
    },
  },
  {
    name: 'pay_for_checkout_session',
    description:
      "Pay for and complete a checkout session, and record this purchase in the buyer's " +
      'long-term preference memory in the same call. Reads the real total from the ' +
      'merchant, delegates payment to the payment provider for exactly that amount, then ' +
      'completes the checkout -- you never specify an amount, it is always read from the ' +
      'merchant, not taken from anything you say. preference_notes and conversation_notes ' +
      'are both required: this call is rejected without them, by design, so a purchase can ' +
      "never go through without also recording what it reveals about the buyer's taste.",
    inputSchema: {
      type: 'object',
      properties: {
        merchant_id: { type: 'string' },
        session_id: { type: 'string' },
        preference_notes: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'Several short, distinct phrases capturing what this purchase reveals about the ' +
            'buyer -- occasion, style, dietary/fit constraints, budget sensitivity, brand ' +
            'affinity, and so on. One phrase per distinct fact, not one long paragraph, so a ' +
            'future semantic search can match on any of them individually. Provide more than one.',
        },
        conversation_notes: {
          type: 'string',
          description:
            'A plain-text summary of the conversation that led to this purchase: what the ' +
            'buyer asked for and why, and any constraints they mentioned. Written for a ' +
            'future reader who was not part of this conversation.',
        },
      },
      required: ['merchant_id', 'session_id', 'preference_notes', 'conversation_notes'],
    },
  },
  {
    name: 'cancel_checkout_session',
    description: 'Cancel an open (not yet paid) checkout session.',
    inputSchema: {
      type: 'object',
      properties: {
        merchant_id: { type: 'string' },
        session_id: { type: 'string' },
        reason: { type: 'string', description: 'why the session is being canceled' },
      },
      required: ['merchant_id', 'session_id'],
    },
  },
  {
    name: 'recall_past_purchases',
    description:
      "Semantically search this buyer's own past purchases and the conversational context " +
      'recorded with them (see pay_for_checkout_session) -- not a product catalog search. ' +
      'Call this whenever the user is looking for or mentions wanting something, alongside ' +
      'search_products, to check whether they bought something like it before: e.g. if they ' +
      'ask for toilet paper and previously bought toilet paper, this surfaces that purchase ' +
      'and why they bought it, so you can mention it (brand they liked, a preference they ' +
      'stated, the merchant). Scoped to this buyer only; empty matches just means no relevant ' +
      'history, not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'One or more short phrases describing what the user is currently looking for or ' +
            'just mentioned (e.g. "toilet paper", "something for a home office on a budget"). ' +
            'Each is searched independently -- provide more than one to cover different ' +
            'angles of the same request if useful.',
        },
        merchant_id: {
          type: 'string',
          description: 'Optional: restrict results to purchases made at one merchant.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Max matches per query, default 5.',
        },
      },
      required: ['queries'],
    },
  },
]

class ToolInputError extends Error {}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value === '') {
    throw new ToolInputError(`"${key}" must be a non-empty string`)
  }
  return value
}

function requireNonEmptyStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key]
  const valid =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string' && v.trim() !== '')
  if (!valid) {
    throw new ToolInputError(`"${key}" must be a non-empty array of non-empty strings`)
  }
  return value as string[]
}

async function readJsonOrThrow(res: Response, context: string): Promise<Record<string, unknown>> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`${context} failed (HTTP ${res.status}): ${JSON.stringify(body)}`)
  }
  return body as Record<string, unknown>
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body),
  })
}

/** Buyer-scoped wiring for recording purchases in the preferences store: the preferences
 * service's base URL, the buyer id to record under (the harness chat session id -- see
 * app.ts), and the embedder used to turn `preference_notes` strings into vectors. */
export interface PreferencesContext {
  baseUrl: string
  buyerId: string
  embedder: Embedder
}

/**
 * Builds a ToolExecutor wired to a specific set of merchant base URLs, a PSP base URL, and a
 * preferences store context, instead of reading a global config singleton -- so tests can
 * point it at throwaway fake servers the same way the merchant/psp projects' own tests do,
 * and app.ts is the only place that wires the real config in (one executor per chat session,
 * since `preferences.buyerId` is per-session).
 */
export function createAcpToolExecutor(
  merchants: Map<string, string>,
  pspUrl: string,
  preferences: PreferencesContext,
): ToolExecutor {
  function merchantBaseUrl(merchantId: string): string {
    const base = merchants.get(merchantId)
    if (!base) {
      const known = [...merchants.keys()]
      throw new ToolInputError(
        `unknown merchant_id "${merchantId}"; configured merchants: ${known.length ? known.join(', ') : '(none -- set MERCHANT_URLS)'}`,
      )
    }
    return base
  }

  async function searchProducts(input: Record<string, unknown>) {
    const query = requireString(input, 'query')
    if (merchants.size === 0) {
      throw new ToolInputError('no merchants configured -- set MERCHANT_URLS')
    }
    const results = await Promise.all(
      [...merchants.entries()].map(async ([merchantId, base]) => {
        const res = await fetch(`${base}/products?q=${encodeURIComponent(query)}`)
        if (!res.ok) return { merchant_id: merchantId, error: `HTTP ${res.status}` }
        const body = (await res.json()) as { products?: unknown }
        return { merchant_id: merchantId, products: body.products ?? [] }
      }),
    )
    return { results }
  }

  async function createCheckoutSession(input: Record<string, unknown>) {
    const base = merchantBaseUrl(requireString(input, 'merchant_id'))
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new ToolInputError('"items" must be a non-empty array')
    }
    const res = await postJson(`${base}/checkout_sessions`, { items: input.items })
    return readJsonOrThrow(res, 'create_checkout_session')
  }

  async function getCheckoutSession(input: Record<string, unknown>) {
    const base = merchantBaseUrl(requireString(input, 'merchant_id'))
    const sessionId = requireString(input, 'session_id')
    const res = await fetch(`${base}/checkout_sessions/${encodeURIComponent(sessionId)}`)
    return readJsonOrThrow(res, 'get_checkout_session')
  }

  async function cancelCheckoutSession(input: Record<string, unknown>) {
    const base = merchantBaseUrl(requireString(input, 'merchant_id'))
    const sessionId = requireString(input, 'session_id')
    const reason = typeof input.reason === 'string' ? input.reason : undefined
    const res = await postJson(
      `${base}/checkout_sessions/${encodeURIComponent(sessionId)}/cancel`,
      {
        intent_trace: reason ? { reason } : undefined,
      },
    )
    return readJsonOrThrow(res, 'cancel_checkout_session')
  }

  /**
   * Semantic lookup over this buyer's past purchases. Embeds each query phrase and runs the
   * preferences store's bulk `$vectorSearch` scoped to `preferences.buyerId` -- never another
   * buyer's history. Returns whatever the preferences service returns (a `results` array
   * keyed by the query text); an embedder/preferences outage surfaces as a thrown error like
   * any other tool failure, since this is a read with nothing to protect by catching it.
   */
  async function recallPastPurchases(input: Record<string, unknown>) {
    const queries = requireNonEmptyStringArray(input, 'queries')
    const merchantId = typeof input.merchant_id === 'string' ? input.merchant_id : undefined
    const limit = typeof input.limit === 'number' ? input.limit : undefined

    const embeddings = await preferences.embedder.embed(queries)
    const res = await postJson(`${preferences.baseUrl}/purchases/search`, {
      buyer_id: preferences.buyerId,
      merchant_id: merchantId,
      queries: queries.map((q, i) => ({ id: q, embedding: embeddings[i], limit })),
    })
    return readJsonOrThrow(res, 'recall_past_purchases')
  }

  /**
   * Embeds each preference note and records the purchase in the preferences store. Called
   * only after the charge has already succeeded, and its failures are caught, not thrown --
   * a tracking outage must never look like the purchase itself failed, or get retried as a
   * double charge. The caller surfaces the outcome in the tool result instead so the model
   * (and ultimately a human) can see tracking didn't happen.
   */
  async function recordPurchasePreferences(
    merchantId: string,
    order: Record<string, unknown>,
    preferenceNotes: string[],
    conversationNotes: string,
  ): Promise<Record<string, unknown>> {
    try {
      const embeddings = await preferences.embedder.embed(preferenceNotes)
      const res = await postJson(`${preferences.baseUrl}/purchases`, {
        buyer_id: preferences.buyerId,
        merchant_id: merchantId,
        product: {
          line_items: order.line_items ?? [],
          totals: order.totals ?? [],
          order: order.order ?? null,
        },
        notes: conversationNotes,
        vectors: preferenceNotes.map((note, i) => ({ label: note, embedding: embeddings[i] })),
      })
      const body = await readJsonOrThrow(res, 'pay_for_checkout_session (record preferences)')
      return { recorded: true, purchase_id: body.purchase_id, vector_count: body.vector_count }
    } catch (err) {
      return { recorded: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function payForCheckoutSession(input: Record<string, unknown>) {
    const merchantId = requireString(input, 'merchant_id')
    const base = merchantBaseUrl(merchantId)
    const sessionId = requireString(input, 'session_id')
    // Required up front, before any money moves: preference tracking can't be skipped by
    // just omitting it, because there is no way to pay without it in the same call.
    const preferenceNotes = requireNonEmptyStringArray(input, 'preference_notes')
    const conversationNotes = requireString(input, 'conversation_notes')

    // 1. Read the session's real state -- the amount we pay is never taken from the model.
    const sessionRes = await fetch(`${base}/checkout_sessions/${encodeURIComponent(sessionId)}`)
    const session = await readJsonOrThrow(sessionRes, 'pay_for_checkout_session (read session)')
    const totals = session.totals as Array<{ type: string; amount: number }> | undefined
    const total = totals?.find((t) => t.type === 'total')?.amount
    if (typeof total !== 'number') {
      throw new Error('pay_for_checkout_session: session has no total to pay')
    }

    // 2. Delegate payment to the PSP for exactly that amount, scoped to this session.
    const dpRes = await postJson(`${pspUrl}/agentic_commerce/delegate_payment`, {
      payment_method: { type: 'card', number: '4242424242424242' },
      allowance: {
        reason: 'one_time',
        max_amount: total,
        currency: session.currency,
        checkout_session_id: sessionId,
        merchant_id: merchantId,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
      risk_signals: [],
      metadata: {},
    })
    const token = await readJsonOrThrow(dpRes, 'pay_for_checkout_session (delegate_payment)')

    // 3. Complete the checkout with that token.
    const completeRes = await postJson(
      `${base}/checkout_sessions/${encodeURIComponent(sessionId)}/complete`,
      { payment_data: { token: token.id } },
    )
    const order = await readJsonOrThrow(completeRes, 'pay_for_checkout_session (complete)')

    // 4. Record this purchase in the preferences store now that the charge succeeded.
    const preferenceTracking = await recordPurchasePreferences(
      merchantId,
      order,
      preferenceNotes,
      conversationNotes,
    )
    return { ...order, preference_tracking: preferenceTracking }
  }

  return async function executeAcpTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case 'search_products':
        return searchProducts(input)
      case 'create_checkout_session':
        return createCheckoutSession(input)
      case 'get_checkout_session':
        return getCheckoutSession(input)
      case 'pay_for_checkout_session':
        return payForCheckoutSession(input)
      case 'cancel_checkout_session':
        return cancelCheckoutSession(input)
      case 'recall_past_purchases':
        return recallPastPurchases(input)
      default:
        throw new Error(`unknown tool "${name}"`)
    }
  }
}
