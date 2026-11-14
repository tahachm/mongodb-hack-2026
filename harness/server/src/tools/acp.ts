import { randomUUID } from 'node:crypto'
import type { ToolDefinition } from '../llm.js'
import type { ToolExecutor } from '../agent.js'

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
      "Pay for and complete a checkout session. Reads the session's real total from the " +
      'merchant, delegates payment to the payment provider for exactly that amount, then ' +
      'completes the checkout. You never specify an amount -- it is always read from the ' +
      'merchant, not taken from anything you say.',
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
]

class ToolInputError extends Error {}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value === '') {
    throw new ToolInputError(`"${key}" must be a non-empty string`)
  }
  return value
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

/**
 * Builds a ToolExecutor wired to a specific set of merchant base URLs and a PSP base URL,
 * instead of reading a global config singleton -- so tests can point it at throwaway fake
 * servers the same way the merchant/psp projects' own tests do, and index.ts is the only
 * place that wires the real config in.
 */
export function createAcpToolExecutor(
  merchants: Map<string, string>,
  pspUrl: string,
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

  async function payForCheckoutSession(input: Record<string, unknown>) {
    const merchantId = requireString(input, 'merchant_id')
    const base = merchantBaseUrl(merchantId)
    const sessionId = requireString(input, 'session_id')

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
    return readJsonOrThrow(completeRes, 'pay_for_checkout_session (complete)')
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
      default:
        throw new Error(`unknown tool "${name}"`)
    }
  }
}
