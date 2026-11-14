import type { ContentPart, InspectAuditEvent, InspectData, InspectRecord, StoredMessage } from './api'
import { isRecord, productsById, type Product } from './productOptions'

/**
 * Turns one session's messages plus its audit trail (GET /sessions/:id/inspect) into one
 * reasoning graph per request: what was asked -> the past records consulted -> what the agent
 * concluded from them -> what it searched -> the products it showed or dropped -> what happened.
 * Pure data; InspectView lays it out and draws it.
 */

export type NodeKind =
  | 'request'
  | 'record'
  | 'ignored'
  | 'insight'
  | 'gap'
  | 'assumption'
  | 'search'
  | 'option'
  | 'rejected'
  | 'outcome'

export const COLUMNS = ['Request', 'History', 'Insights', 'Searches', 'Products', 'Outcome'] as const

const COLUMN_OF: Record<NodeKind, number> = {
  request: 0,
  record: 1,
  ignored: 1,
  insight: 2,
  gap: 2,
  assumption: 2,
  search: 3,
  option: 4,
  rejected: 4,
  outcome: 5,
}

export interface GraphNode {
  id: string
  kind: NodeKind
  column: number
  title: string
  subtitle?: string
  badge?: string
  image?: string
  /** Label/value pairs for the side panel. */
  details: Array<[string, string]>
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  /** A weaker link, drawn faint -- e.g. a search that also returned a product that was dropped. */
  faint?: boolean
}

export interface Step {
  kind: 'model' | 'tool'
  label: string
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  error?: boolean
}

export interface InspectRun {
  id: string
  label: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  steps: Step[]
  totals: { durationMs: number; inputTokens: number; outputTokens: number }
}

type ToolCall = Extract<ContentPart, { type: 'tool_call' }>
type ToolResult = Extract<ContentPart, { type: 'tool_result' }>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string')

function money(cents: unknown, currency = 'USD'): string {
  if (typeof cents !== 'number') return ''
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const isUserText = (m: StoredMessage) =>
  m.role === 'user' && m.content.some((part) => part.type === 'text')

const textOf = (m: StoredMessage) =>
  m.content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')

/** "Kind: purchased\nRequest: ...\nDecision: ..." -> { kind, request, decision, ... }. */
function parseNotes(notes: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of notes.split('\n')) {
    const match = /^([A-Za-z ]+):\s*(.*)$/.exec(line)
    if (match) fields[match[1].trim().toLowerCase()] = match[2].trim()
  }
  return fields
}

function recordNode(id: string, record: InspectRecord | undefined, ignoredReason?: string): GraphNode {
  const fields = record ? parseNotes(record.notes) : {}
  const product = record?.product
  const productName = product ? str(product.name) : ''
  const date = record?.created ? new Date(record.created).toLocaleDateString() : ''
  const kind = fields.kind ? fields.kind.replace(/_/g, ' ') : 'record'
  const details: Array<[string, string]> = [['Record', id]]
  if (fields.kind) details.push(['Kind', kind])
  if (date) details.push(['Saved', date])
  if (record?.merchant_id) details.push(['Merchant', record.merchant_id])
  if (fields.request) details.push(['They asked', fields.request])
  if (fields['options shown']) details.push(['Shown', fields['options shown']])
  if (fields.decision) details.push(['Decision', fields.decision])
  if (productName) details.push(['Product', productName])
  if (ignoredReason) details.push(['Ignored because', ignoredReason])
  if (!record) details.push(['Note', 'Not found in purchase_vectors.'])
  return {
    id: `record:${id}`,
    kind: ignoredReason ? 'ignored' : 'record',
    column: COLUMN_OF[ignoredReason ? 'ignored' : 'record'],
    title: truncate(fields.request || fields.decision || productName || id, 90),
    subtitle: ignoredReason ? `Ignored: ${truncate(ignoredReason, 70)}` : [kind, date].filter(Boolean).join(' · '),
    image: product ? str(product.imageUrl) || undefined : undefined,
    details,
  }
}

/** Groups the session's audit events into runs (one per request) in the order they began. */
function groupRuns(events: InspectAuditEvent[]): InspectAuditEvent[][] {
  const runs = new Map<string, InspectAuditEvent[]>()
  // By time, not seq: seq counts per buyer, and one chat's events can span two buyers.
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const run = runs.get(event.run_id) ?? []
    run.push(event)
    runs.set(event.run_id, run)
  }
  return [...runs.values()]
}

/** Message index of the tool_result that returned each audit event's id. */
function eventMessageIndex(messages: StoredMessage[]): Map<string, number> {
  const index = new Map<string, number>()
  messages.forEach((message, i) => {
    for (const part of message.content) {
      if (part.type !== 'tool_result' || part.isError || !isRecord(part.output)) continue
      const eventId = part.output.event_id
      if (typeof eventId === 'string') index.set(eventId, i)
    }
  })
  return index
}

function buildRun(
  runEvents: InspectAuditEvent[],
  messages: StoredMessage[],
  range: [number, number],
  records: Map<string, InspectRecord>,
  products: Map<string, Product>,
): InspectRun {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const nodeIds = new Set<string>()
  const addNode = (node: GraphNode) => {
    if (nodeIds.has(node.id)) return
    nodeIds.add(node.id)
    nodes.push(node)
  }
  const addEdge = (source: string, target: string, faint = false) => {
    const id = `${source}->${target}`
    if (!edges.some((e) => e.id === id)) edges.push({ id, source, target, faint })
  }

  const insightsEvents = runEvents.filter((e) => e.type === 'history_insights')
  const planEvents = runEvents.filter((e) => e.type === 'recommendation_plan')
  const insights = insightsEvents.at(-1)?.payload ?? {}
  const plan = planEvents.at(-1)?.payload

  const slice = messages.slice(range[0], range[1])
  const requestMessage = slice.find(isUserText)
  const requestText = requestMessage ? textOf(requestMessage) : str(insights.request)

  // ---- request
  const requestId = 'request'
  addNode({
    id: requestId,
    kind: 'request',
    column: COLUMN_OF.request,
    title: truncate(requestText || 'Request', 120),
    subtitle: str(insights.request) ? truncate(str(insights.request), 90) : undefined,
    details: [
      ['You said', requestText],
      ['Agent understood', str(insights.request)],
      ['Summary', str(insights.summary)],
      ['Follow-up question', str(insights.follow_up_question)],
      ['Revisions', insightsEvents.length > 1 ? `${insightsEvents.length} insights events` : ''],
    ].filter(([, v]) => v) as Array<[string, string]>,
  })

  // ---- history records and insights
  const ignored = new Map(
    arr(insights.ignored_records)
      .filter(isRecord)
      .map((r) => [str(r.record_id), str(r.reason)] as const),
  )
  for (const [id, reason] of ignored) addNode(recordNode(id, records.get(id), reason))

  const facetNode = new Map<string, string>()
  arr(insights.insights)
    .filter(isRecord)
    .forEach((insight, i) => {
      const facet = str(insight.facet)
      const id = `insight:${i}`
      facetNode.set(facet.toLowerCase(), id)
      const evidence = strings(insight.evidence)
      addNode({
        id,
        kind: 'insight',
        column: COLUMN_OF.insight,
        title: `${facet}: ${truncate(str(insight.finding), 80)}`,
        badge: str(insight.confidence),
        details: [
          ['Facet', facet],
          ['Finding', str(insight.finding)],
          ['Confidence', str(insight.confidence)],
          ['Evidence', evidence.join(', ')],
        ],
      })
      const recordIds = evidence.filter((e) => records.has(e) || e.startsWith('pur_'))
      for (const recordId of recordIds) {
        addNode(recordNode(recordId, records.get(recordId)))
        addEdge(`record:${recordId}`, id)
      }
      // Evidence from the conversation itself (not a saved record) comes straight from the request.
      if (recordIds.length < evidence.length || evidence.length === 0) addEdge(requestId, id)
    })

  arr(insights.gaps)
    .filter(isRecord)
    .forEach((gap, i) => {
      const id = `gap:${i}`
      addNode({
        id,
        kind: 'gap',
        column: COLUMN_OF.gap,
        title: `${str(gap.facet)}: unknown`,
        subtitle: truncate(str(gap.note), 80),
        badge: str(gap.action),
        details: [
          ['Facet', str(gap.facet)],
          ['Important', gap.important ? 'yes' : 'no'],
          ['Action', str(gap.action)],
          ['Note', str(gap.note)],
        ],
      })
      addEdge(requestId, id, true)
    })

  const reliedOn = new Set(strings(plan?.assumptions_relied_on))
  strings(insights.assumptions).forEach((assumption, i) => {
    const id = `assumption:${i}`
    addNode({
      id,
      kind: 'assumption',
      column: COLUMN_OF.assumption,
      title: truncate(assumption, 90),
      badge: 'assumed',
      details: [
        ['Assumption', assumption],
        ['Relied on by the plan', reliedOn.has(assumption) ? 'yes' : 'no'],
      ],
    })
    addEdge(requestId, id, true)
  })

  // ---- searches (from the actual tool calls when we have them, else the plan's list)
  const calls = new Map<string, ToolCall>()
  const searchProducts = new Map<string, Set<string>>()
  for (const message of slice) {
    for (const part of message.content) {
      if (part.type === 'tool_call') calls.set(part.id, part)
    }
  }
  let searchCount = 0
  for (const message of slice) {
    for (const part of message.content) {
      if (part.type !== 'tool_result' || part.name !== 'search_products') continue
      const result = part as ToolResult
      const query = str(calls.get(result.id)?.input.query)
      const id = `search:${searchCount++}`
      const found = new Set<string>()
      const perMerchant: string[] = []
      let total = 0
      for (const merchant of arr(isRecord(result.output) ? result.output.results : undefined)) {
        if (!isRecord(merchant)) continue
        const matches =
          typeof merchant.total_matches === 'number' ? merchant.total_matches : arr(merchant.products).length
        total += matches
        perMerchant.push(`${str(merchant.merchant_id)} ${matches}`)
        for (const product of arr(merchant.products)) {
          if (isRecord(product) && typeof product.id === 'string') found.add(product.id)
        }
      }
      searchProducts.set(id, found)
      addNode({
        id,
        kind: 'search',
        column: COLUMN_OF.search,
        title: `“${query}”`,
        subtitle: result.isError ? 'failed' : `${total} matches · ${perMerchant.join(', ')}`,
        details: [
          ['Query', query],
          ['Matches', String(total)],
          ['By merchant', perMerchant.join(', ')],
          ['Took', result.durationMs != null ? `${Math.round(result.durationMs)} ms` : ''],
        ].filter(([, v]) => v) as Array<[string, string]>,
      })
      addEdge(requestId, id)
    }
  }
  if (searchCount === 0) {
    for (const query of strings(plan?.searches)) {
      const id = `search:${searchCount++}`
      addNode({
        id,
        kind: 'search',
        column: COLUMN_OF.search,
        title: `“${query}”`,
        details: [['Query', query]],
      })
      addEdge(requestId, id)
    }
  }

  // ---- products shown and dropped
  const highlighted = str(plan?.highlighted_product_id)
  const productNodeFor = new Map<string, string>()
  const linkFromSearches = (productId: string, nodeId: string, faint: boolean) => {
    let linked = false
    for (const [searchId, found] of searchProducts) {
      if (found.has(productId)) {
        addEdge(searchId, nodeId, faint)
        linked = true
      }
    }
    return linked
  }

  arr(plan?.options)
    .filter(isRecord)
    .sort((a, b) => Number(a.option_number) - Number(b.option_number))
    .forEach((option) => {
      const productId = str(option.product_id)
      const product = products.get(productId)
      const id = `product:${productId}`
      productNodeFor.set(productId, id)
      const top = productId === highlighted
      addNode({
        id,
        kind: 'option',
        column: COLUMN_OF.option,
        title: truncate(product?.name ?? productId, 80),
        subtitle: [money(option.price_cents), strings(option.merchant_ids).join(', ')]
          .filter(Boolean)
          .join(' · '),
        badge: top ? 'top pick' : `option ${str(String(option.option_number ?? ''))}`,
        image: product?.image_url,
        details: [
          ['Product', product?.name ?? productId],
          ['Price', money(option.price_cents)],
          ['Merchants', strings(option.merchant_ids).join(', ')],
          ['Why', str(option.why)],
          ['Tradeoff', str(option.tradeoff)],
          ['Unknowns', strings(option.unknowns).join('; ')],
          ['Insights used', strings(option.insights_used).join(', ')],
          ['Top pick because', top ? str(plan?.highlight_reason) : ''],
        ].filter(([, v]) => v) as Array<[string, string]>,
      })
      let linked = linkFromSearches(productId, id, false)
      for (const facet of strings(option.insights_used)) {
        const insightId = facetNode.get(facet.toLowerCase())
        if (insightId) {
          addEdge(insightId, id)
          linked = true
        }
      }
      if (!linked) for (const searchId of searchProducts.keys()) addEdge(searchId, id, true)
    })

  arr(plan?.not_shown)
    .filter(isRecord)
    .forEach((entry) => {
      const productId = str(entry.product_id)
      const product = products.get(productId)
      const id = `product:${productId}`
      if (nodeIds.has(id)) return
      addNode({
        id,
        kind: 'rejected',
        column: COLUMN_OF.rejected,
        title: truncate(product?.name ?? productId, 80),
        subtitle: `Dropped: ${truncate(str(entry.reason), 70)}`,
        image: product?.image_url,
        details: [
          ['Product', product?.name ?? productId],
          ['Price', money(product?.price_cents)],
          ['Dropped because', str(entry.reason)],
        ].filter(([, v]) => v) as Array<[string, string]>,
      })
      linkFromSearches(productId, id, true)
    })

  if (plan && str(plan.no_fit_explanation)) {
    addNode({
      id: 'no-fit',
      kind: 'rejected',
      column: COLUMN_OF.rejected,
      title: 'Nothing fit',
      subtitle: truncate(str(plan.no_fit_explanation), 90),
      details: [['Why', str(plan.no_fit_explanation)]],
    })
  }

  // ---- outcome: checkouts, payments and the record saved afterwards
  let lastOutcome: string | undefined
  for (const message of slice) {
    for (const part of message.content) {
      if (part.type !== 'tool_result' || part.isError || !isRecord(part.output)) continue
      const output = part.output
      if (
        part.name === 'create_checkout_session' ||
        part.name === 'pay_for_checkout_session' ||
        part.name === 'cancel_checkout_session'
      ) {
        const sessionId = str(output.id)
        const id = `checkout:${sessionId}`
        const items = arr(output.line_items).filter(isRecord)
        const total = arr(output.totals)
          .filter(isRecord)
          .find((t) => t.type === 'total')?.amount
        const order = isRecord(output.order) ? str(output.order.id) : ''
        const status = str(output.status)
        const title =
          status === 'completed' ? 'Ordered' : status === 'canceled' ? 'Checkout canceled' : 'Checkout opened'
        // A later call for the same session (pay after create) replaces the node in place.
        const existing = nodes.findIndex((n) => n.id === id)
        const node: GraphNode = {
          id,
          kind: 'outcome',
          column: COLUMN_OF.outcome,
          title,
          subtitle: [money(total), str(output.merchant_id), order].filter(Boolean).join(' · '),
          badge: status,
          details: [
            ['Status', status],
            ['Merchant', str(output.merchant_id)],
            ['Items', items.map((li) => str(li.title)).join('; ')],
            ['Total', money(total)],
            ['Checkout session', sessionId],
            ['Order', order],
          ].filter(([, v]) => v) as Array<[string, string]>,
        }
        if (existing >= 0) nodes[existing] = node
        else addNode(node)
        for (const li of items) {
          const itemId = isRecord(li.item) ? str(li.item.id) : ''
          const from = productNodeFor.get(itemId) ?? (nodeIds.has(`product:${itemId}`) ? `product:${itemId}` : requestId)
          addEdge(from, id)
        }
        lastOutcome = id
      } else if (part.name === 'save_preference_record') {
        const call = calls.get(part.id)
        const id = `saved:${part.id}`
        addNode({
          id,
          kind: 'outcome',
          column: COLUMN_OF.outcome,
          title: 'Saved to history',
          subtitle: str(call?.input.kind).replace(/_/g, ' '),
          badge: 'record',
          details: [
            ['Kind', str(call?.input.kind)],
            ['Request', str(call?.input.request)],
            ['Decision', str(call?.input.decision)],
          ].filter(([, v]) => v) as Array<[string, string]>,
        })
        addEdge(lastOutcome ?? requestId, id)
      }
    }
  }

  // ---- steps: every model call and tool run in this request, with timing and tokens
  const steps: Step[] = []
  const totals = { durationMs: 0, inputTokens: 0, outputTokens: 0 }
  for (const message of slice) {
    if (message.role === 'assistant' && message.metrics) {
      const produced = message.content
        .map((p) => (p.type === 'tool_call' ? p.name : p.type === 'text' ? 'reply' : ''))
        .filter(Boolean)
      steps.push({
        kind: 'model',
        label: `Model → ${produced.join(', ') || 'nothing'}`,
        durationMs: message.metrics.durationMs,
        inputTokens: message.metrics.inputTokens,
        outputTokens: message.metrics.outputTokens,
      })
      totals.durationMs += message.metrics.durationMs
      totals.inputTokens += message.metrics.inputTokens
      totals.outputTokens += message.metrics.outputTokens
    }
    for (const part of message.content) {
      if (part.type !== 'tool_result') continue
      steps.push({ kind: 'tool', label: part.name, durationMs: part.durationMs, error: part.isError })
    }
  }

  return {
    id: runEvents[0]?.run_id ?? 'run',
    label: truncate(requestText || str(insights.request) || 'Request', 48),
    nodes,
    edges,
    steps,
    totals,
  }
}

export function buildRuns(
  messages: StoredMessage[],
  data: InspectData,
  sessionCreatedAt?: string,
): InspectRun[] {
  const records = new Map(data.records.map((r) => [r.purchase_id, r]))
  const products = productsById(messages)
  const eventIndex = eventMessageIndex(messages)
  // Session ids can be reused (the harness currently hardcodes one for testing), so the audit
  // log holds earlier chats' events under the same id too -- keep only this chat's.
  const events = sessionCreatedAt
    ? data.events.filter((e) => e.at >= sessionCreatedAt)
    : data.events
  const runs = groupRuns(events)

  // Each run starts at the user message that preceded its first recorded event, and lasts
  // until the next run's starting message -- so a follow-up like "yes, buy it" (no new
  // reasoning) stays with the request it was about.
  const starts = runs.map((run) => {
    const first = Math.min(...run.map((e) => eventIndex.get(e.event_id) ?? Infinity))
    if (!Number.isFinite(first)) return -1
    for (let i = first; i >= 0; i--) if (isUserText(messages[i])) return i
    return -1
  })

  return runs.map((run, r) => {
    const start = starts[r]
    let end = messages.length
    for (let k = r + 1; k < runs.length; k++) {
      if (starts[k] > start) {
        end = starts[k]
        break
      }
    }
    return buildRun(run, messages, start >= 0 ? [start, end] : [0, 0], records, products)
  })
}
