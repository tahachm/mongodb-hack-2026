import { randomUUID } from 'node:crypto'
import type { ToolExecutor } from '../agent.js'
import { type AuditEventLink, AuditEventStore } from '../auditEvents.js'
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
    name: 'record_audit_event',
    description:
      'Append an event to the audit log -- an append-only record a reviewer reads to see ' +
      'what you knew and why you acted, and that you use to answer "why?" later. Separate ' +
      "from the preference store: it's never searched as evidence of what the buyer likes, " +
      "so this is where your own conclusions belong. Entries can't be edited or deleted. " +
      'Returns { event_id, seq }.\n\n' +
      'Two event types, chosen with "type":\n' +
      '- "history_insights": what you concluded from the buyer\'s history and this ' +
      'conversation, before seeing any products. Record this before asking a follow-up or ' +
      'reading product results.\n' +
      '- "recommendation_plan": what you are about to recommend and why, after comparing ' +
      'products and before writing the recommendation message. Record this before showing ' +
      'options.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['history_insights', 'recommendation_plan'],
        },
        updates_event_id: {
          type: ['string', 'null'],
          description:
            '(history_insights only) null for the first insights of a request; the earlier ' +
            "event's id when revising insights after the buyer answers a follow-up.",
        },
        request: {
          type: 'string',
          description:
            '(history_insights only) the request as you understand it, including anything ' +
            'said about it in this conversation.',
        },
        insights: {
          type: 'array',
          description: '(history_insights only) one entry per facet the evidence settles.',
          items: {
            type: 'object',
            properties: {
              facet: { type: 'string' },
              finding: { type: 'string' },
              evidence: {
                type: 'array',
                items: { type: 'string' },
                description: 'purchase_id of each record relied on, or "this conversation".',
              },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['facet', 'finding', 'evidence', 'confidence'],
          },
        },
        ignored_records: {
          type: 'array',
          description: '(history_insights only) records returned by search but not used.',
          items: {
            type: 'object',
            properties: {
              record_id: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['record_id', 'reason'],
          },
        },
        gaps: {
          type: 'array',
          description: '(history_insights only) every facet with no relevant evidence.',
          items: {
            type: 'object',
            properties: {
              facet: { type: 'string' },
              important: { type: 'boolean' },
              action: { type: 'string', enum: ['ask', 'assume', 'skip'] },
              note: { type: 'string' },
            },
            required: ['facet', 'important', 'action', 'note'],
          },
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: '(history_insights only) defaults stated to the buyer instead of asking.',
        },
        follow_up_question: {
          type: ['string', 'null'],
          description: '(history_insights only) the question you are about to ask, or null.',
        },
        insights_event_id: {
          type: 'string',
          description:
            '(recommendation_plan only) the event_id of the latest history_insights for ' +
            'this request.',
        },
        searches: {
          type: 'array',
          items: { type: 'string' },
          description: '(recommendation_plan only) the queries sent to search_products.',
        },
        options: {
          type: 'array',
          description:
            '(recommendation_plan only) what you will show, in order, highlighted one first.',
          items: {
            type: 'object',
            properties: {
              option_number: { type: 'integer' },
              product_id: { type: 'string' },
              merchant_ids: { type: 'array', items: { type: 'string' } },
              price_cents: { type: 'integer' },
              why: { type: 'string', description: 'the reasons actually used.' },
              insights_used: { type: 'array', items: { type: 'string' }, description: 'facets.' },
              unknowns: { type: 'array', items: { type: 'string' } },
              tradeoff: { type: 'string' },
            },
            required: [
              'option_number',
              'product_id',
              'merchant_ids',
              'price_cents',
              'why',
              'insights_used',
              'unknowns',
              'tradeoff',
            ],
          },
        },
        highlighted_product_id: {
          type: ['string', 'null'],
          description: '(recommendation_plan only)',
        },
        highlight_reason: { type: ['string', 'null'], description: '(recommendation_plan only)' },
        not_shown: {
          type: 'array',
          description:
            '(recommendation_plan only) every candidate considered and not shown, with why.',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['product_id', 'reason'],
          },
        },
        assumptions_relied_on: {
          type: 'array',
          items: { type: 'string' },
          description: '(recommendation_plan only)',
        },
        no_fit_explanation: {
          type: ['string', 'null'],
          description:
            '(recommendation_plan only) when nothing fits, what was missing; options is ' +
            'then empty. Otherwise null.',
        },
        summary: {
          type: 'string',
          description: 'one short paragraph/sentence summarizing this event.',
        },
      },
      required: ['type'],
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
      'Pay for and complete a checkout session. Reads the real total from the merchant, ' +
      'delegates payment to the payment provider for exactly that amount, then completes ' +
      'the checkout -- you never specify an amount, it is always read from the merchant, ' +
      'not taken from anything you say. Returns the completed session with its order. ' +
      'This does not save anything to the preference store -- call save_preference_record ' +
      'separately once the request is finished.',
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
  {
    name: 'search_preferences',
    description:
      "Semantically search this buyer's saved preference records (see save_preference_record) " +
      '-- past purchases, past choices, and things they have told you, not a product catalog ' +
      'search. Call this whenever the user is looking for or mentions wanting something, ' +
      'alongside search_products, to check what their history says about it. Scoped to this ' +
      'buyer only; empty matches just means no relevant history, not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          minItems: 1,
          description:
            'One or more queries, run together. "id" is your own label for lining up ' +
            '`results[i]` with the query it answers -- it can differ from "text" (e.g. id ' +
            '"colour" labelling text "Colours the user likes or avoids in clothing"). "limit" ' +
            'is 5 by default, up to 50.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              limit: { type: 'integer', minimum: 1, maximum: 50 },
            },
            required: ['id', 'text'],
          },
        },
        merchant_id: {
          type: ['string', 'null'],
          description: 'Optional: restrict results to records at one merchant.',
        },
      },
      required: ['queries'],
    },
  },
  {
    name: 'save_preference_record',
    description:
      'Save one record of a finished shopping request: what the buyer asked for, what was ' +
      'shown, and what they chose and why. A later search_preferences call can find it by ' +
      'meaning. Save exactly one record per finished request -- see "kind" for what counts ' +
      "as finished. Records can't be edited or deleted once saved, so write them carefully.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['purchased', 'selected', 'rejected_all', 'no_decision', 'stated_preference'],
          description:
            'purchased: they bought it and the order completed. selected: they picked one ' +
            "but didn't buy it. rejected_all: they rejected every option and moved on. " +
            'no_decision: they left the request for something else without deciding. ' +
            'stated_preference: not tied to a request -- they told you something worth ' +
            'remembering, or corrected what you remembered; comparison is "" and product is ' +
            'null for this kind.',
        },
        request: {
          type: 'string',
          description:
            'What the buyer asked for and everything they told you about what they wanted, ' +
            'quoting their words, including answers to your questions.',
        },
        comparison: {
          type: 'string',
          description:
            'What you showed them, factually: for each option, product type, brand, price, ' +
            'attributes that mattered, merchants, which one you highlighted and why, and what ' +
            'you assumed or could not tell. "" for stated_preference.',
        },
        decision: {
          type: 'string',
          description:
            'What they did, and their reason in their own words. Say so if they gave no ' +
            'reason -- never add your own interpretation.',
        },
        merchant_id: {
          type: ['string', 'null'],
          description: 'The merchant of the chosen product, or null if none was chosen.',
        },
        product: {
          type: ['object', 'null'],
          description:
            'The chosen product, copied exactly as search_products returned it, or null if ' +
            'none was chosen.',
        },
        options_shown: {
          type: 'array',
          description:
            'Every product shown in this request, with the merchant it would have sold from.',
          items: {
            type: 'object',
            properties: {
              merchant_id: { type: 'string' },
              product_id: { type: 'string' },
            },
            required: ['merchant_id', 'product_id'],
          },
        },
      },
      required: [
        'kind',
        'request',
        'comparison',
        'decision',
        'merchant_id',
        'product',
        'options_shown',
      ],
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

function requireNullableObject(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = input[key]
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolInputError(`"${key}" must be an object or null`)
  }
  return value as Record<string, unknown>
}

/** Unlike requireNullableString, the key itself may be omitted entirely (not just null) --
 * for optional filters like search_preferences' merchant_id, where the model simply leaves
 * the field out rather than sending an explicit null. */
function optionalNullableString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ToolInputError(`"${key}" must be a string or null`)
  }
  return value
}

export interface HistoryInsightsEvent {
  type: 'history_insights'
  updates_event_id: string | null
  request: string
  insights: Array<{
    facet: string
    finding: string
    evidence: string[]
    confidence: 'high' | 'medium' | 'low'
  }>
  ignored_records: Array<{ record_id: string; reason: string }>
  gaps: Array<{
    facet: string
    important: boolean
    action: 'ask' | 'assume' | 'skip'
    note: string
  }>
  assumptions: string[]
  follow_up_question: string | null
  summary: string
}

export interface RecommendationPlanEvent {
  type: 'recommendation_plan'
  insights_event_id: string
  searches: string[]
  options: Array<{
    option_number: number
    product_id: string
    merchant_ids: string[]
    price_cents: number
    why: string
    insights_used: string[]
    unknowns: string[]
    tradeoff: string
  }>
  highlighted_product_id: string | null
  highlight_reason: string | null
  not_shown: Array<{ product_id: string; reason: string }>
  assumptions_relied_on: string[]
  no_fit_explanation: string | null
  summary: string
}

export type AuditEvent = HistoryInsightsEvent | RecommendationPlanEvent

function requireStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key]
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ToolInputError(`"${key}" must be an array of strings`)
  }
  return value as string[]
}

function requireNullableString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  if (value !== null && typeof value !== 'string') {
    throw new ToolInputError(`"${key}" must be a string or null`)
  }
  return value as string | null
}

function requireBoolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key]
  if (typeof value !== 'boolean') {
    throw new ToolInputError(`"${key}" must be a boolean`)
  }
  return value
}

function requireNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key]
  if (typeof value !== 'number') {
    throw new ToolInputError(`"${key}" must be a number`)
  }
  return value
}

function requireEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = input[key]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ToolInputError(`"${key}" must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function requireObjectArray(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const value = input[key]
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null)) {
    throw new ToolInputError(`"${key}" must be an array of objects`)
  }
  return value as Record<string, unknown>[]
}

/** Runs `parseEntry` over every element of `input[key]`, rewrapping any ToolInputError it
 * throws with the array index so validation errors point at exactly which entry is wrong
 * (e.g. "insights[2]: ..."), instead of a bare field name that could be any entry's. */
function requireEntries<T>(
  input: Record<string, unknown>,
  key: string,
  parseEntry: (entry: Record<string, unknown>) => T,
): T[] {
  return requireObjectArray(input, key).map((entry, i) => {
    try {
      return parseEntry(entry)
    } catch (err) {
      throw new ToolInputError(`${key}[${i}]: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/** Validates a `record_audit_event` call shaped like `history_insights` -- see section 2.3 of
 * agent-system-prompt.md for the field-by-field meaning. Thrown errors surface to the model
 * as a tool error, same as every other validated tool input in this file. */
function parseHistoryInsights(input: Record<string, unknown>): HistoryInsightsEvent {
  return {
    type: 'history_insights',
    updates_event_id: requireNullableString(input, 'updates_event_id'),
    request: requireString(input, 'request'),
    insights: requireEntries(input, 'insights', (e) => ({
      facet: requireString(e, 'facet'),
      finding: requireString(e, 'finding'),
      evidence: requireStringArray(e, 'evidence'),
      confidence: requireEnum(e, 'confidence', ['high', 'medium', 'low'] as const),
    })),
    ignored_records: requireEntries(input, 'ignored_records', (e) => ({
      record_id: requireString(e, 'record_id'),
      reason: requireString(e, 'reason'),
    })),
    gaps: requireEntries(input, 'gaps', (e) => ({
      facet: requireString(e, 'facet'),
      important: requireBoolean(e, 'important'),
      action: requireEnum(e, 'action', ['ask', 'assume', 'skip'] as const),
      note: requireString(e, 'note'),
    })),
    assumptions: requireStringArray(input, 'assumptions'),
    follow_up_question: requireNullableString(input, 'follow_up_question'),
    summary: requireString(input, 'summary'),
  }
}

/** Validates a `record_audit_event` call shaped like `recommendation_plan` -- see section 2.3
 * of agent-system-prompt.md for the field-by-field meaning. */
function parseRecommendationPlan(input: Record<string, unknown>): RecommendationPlanEvent {
  return {
    type: 'recommendation_plan',
    insights_event_id: requireString(input, 'insights_event_id'),
    searches: requireStringArray(input, 'searches'),
    options: requireEntries(input, 'options', (e) => ({
      option_number: requireNumber(e, 'option_number'),
      product_id: requireString(e, 'product_id'),
      merchant_ids: requireStringArray(e, 'merchant_ids'),
      price_cents: requireNumber(e, 'price_cents'),
      why: requireString(e, 'why'),
      insights_used: requireStringArray(e, 'insights_used'),
      unknowns: requireStringArray(e, 'unknowns'),
      tradeoff: requireString(e, 'tradeoff'),
    })),
    highlighted_product_id: requireNullableString(input, 'highlighted_product_id'),
    highlight_reason: requireNullableString(input, 'highlight_reason'),
    not_shown: requireEntries(input, 'not_shown', (e) => ({
      product_id: requireString(e, 'product_id'),
      reason: requireString(e, 'reason'),
    })),
    assumptions_relied_on: requireStringArray(input, 'assumptions_relied_on'),
    no_fit_explanation: requireNullableString(input, 'no_fit_explanation'),
    summary: requireString(input, 'summary'),
  }
}

function parseAuditEvent(input: Record<string, unknown>): AuditEvent {
  const type = requireEnum(input, 'type', ['history_insights', 'recommendation_plan'] as const)
  return type === 'history_insights' ? parseHistoryInsights(input) : parseRecommendationPlan(input)
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
 * service's base URL and the buyer id to record under (the harness chat session id -- see
 * app.ts). No embedder -- MongoDB Atlas Vector Search's Automated Embedding generates vectors
 * server-side from the raw text we send; we never call an embedding API ourselves. */
export interface PreferencesContext {
  baseUrl: string
  buyerId: string
}

/**
 * Builds a ToolExecutor wired to a specific set of merchant base URLs, a PSP base URL, a
 * preferences store context, and an audit event store, instead of reading a global config
 * singleton -- so tests can point it at throwaway fake servers the same way the merchant/psp
 * projects' own tests do, and app.ts is the only place that wires the real config in (one
 * executor per chat session, since `preferences.buyerId` is per-session).
 */
export function createAcpToolExecutor(
  merchants: Map<string, string>,
  pspUrl: string,
  preferences: PreferencesContext,
  auditEvents: AuditEventStore,
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

  /** Validates the call, then hands it to AuditEventStore (auditEvents.ts) to resolve its
   * run_id, assign a hash-chained seq/event_id, and persist `input` verbatim as the payload.
   * See AuditEventStore's own docstring for what "verbatim" and the hash chain mean. */
  async function recordAuditEvent(input: Record<string, unknown>) {
    const parsed = parseAuditEvent(input)
    const link: AuditEventLink =
      parsed.type === 'history_insights'
        ? { type: 'history_insights', updatesEventId: parsed.updates_event_id }
        : { type: 'recommendation_plan', insightsEventId: parsed.insights_event_id }
    return auditEvents.record(input, link, {
      sessionId: preferences.buyerId,
      buyerId: preferences.buyerId,
    })
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

  /** Bulk semantic lookup over this buyer's saved preference records: runs the preferences
   * store's `$vectorSearch`, scoped to `preferences.buyerId` -- never another buyer's
   * history. Each query's `text` is sent as raw text; MongoDB Atlas Automated Embedding
   * embeds it server-side using the same model as the index, so results are directly
   * comparable with no embedding step on our end. Returns the service's response as is. */
  async function searchPreferences(input: Record<string, unknown>) {
    const queries = requireEntries(input, 'queries', (e) => {
      const limit = e.limit
      if (limit !== undefined && typeof limit !== 'number') {
        throw new ToolInputError('"limit" must be a number')
      }
      return { id: requireString(e, 'id'), text: requireString(e, 'text'), limit }
    })
    if (queries.length === 0) {
      throw new ToolInputError('"queries" must be a non-empty array')
    }
    const merchantId = optionalNullableString(input, 'merchant_id')

    const res = await postJson(`${preferences.baseUrl}/purchases/search`, {
      buyer_id: preferences.buyerId,
      merchant_id: merchantId,
      queries: queries.map((q) => ({ id: q.id, text: q.text, limit: q.limit })),
    })
    return readJsonOrThrow(res, 'search_preferences')
  }

  /** Saves one preference record exactly as the model described it, not derived from a
   * purchase the way the old pay_for_checkout_session + recordPurchasePreferences coupling
   * worked -- this can run for any finished request, bought or not. `notes` and `vectors` are
   * built here, matching section 2.2 of agent-system-prompt.md; the preferences service
   * itself is unaware of `kind`/`request`/`comparison`/`decision` as separate fields, it only
   * ever sees `notes` (the concatenation) and `vectors` (one per non-empty narrative field). */
  async function savePreferenceRecord(input: Record<string, unknown>) {
    const kind = requireEnum(input, 'kind', [
      'purchased',
      'selected',
      'rejected_all',
      'no_decision',
      'stated_preference',
    ] as const)
    const request = requireString(input, 'request')
    const comparisonValue = input.comparison
    if (typeof comparisonValue !== 'string') {
      throw new ToolInputError('"comparison" must be a string')
    }
    const decision = requireString(input, 'decision')
    const merchantId = requireNullableString(input, 'merchant_id')
    const product = requireNullableObject(input, 'product')
    const optionsShown = requireEntries(input, 'options_shown', (e) => ({
      merchant_id: requireString(e, 'merchant_id'),
      product_id: requireString(e, 'product_id'),
    }))

    const optionIds = optionsShown.map((o) => `${o.merchant_id}/${o.product_id}`).join(', ')
    const notes =
      `Kind: ${kind}\n` +
      `Request: ${request}\n` +
      `Options shown: ${comparisonValue}\n` +
      `Decision: ${decision}\n` +
      `Option ids: ${optionIds}`

    const vectors = [
      { label: 'request', text: request },
      ...(comparisonValue.trim() !== '' ? [{ label: 'comparison', text: comparisonValue }] : []),
      ...(decision.trim() !== '' ? [{ label: 'decision', text: decision }] : []),
    ]

    const res = await postJson(`${preferences.baseUrl}/purchases`, {
      buyer_id: preferences.buyerId,
      merchant_id: merchantId,
      // The service requires an object -- {} stands in for "no product chosen".
      product: product ?? {},
      notes,
      vectors,
    })
    return readJsonOrThrow(res, 'save_preference_record')
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

    // 3. Complete the checkout with that token. Preference recording is a separate tool call
    // now (save_preference_record) -- not bundled in here.
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
      case 'record_audit_event':
        return recordAuditEvent(input)
      case 'get_checkout_session':
        return getCheckoutSession(input)
      case 'pay_for_checkout_session':
        return payForCheckoutSession(input)
      case 'cancel_checkout_session':
        return cancelCheckoutSession(input)
      case 'search_preferences':
        return searchPreferences(input)
      case 'save_preference_record':
        return savePreferenceRecord(input)
      default:
        throw new Error(`unknown tool "${name}"`)
    }
  }
}
