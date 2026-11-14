import type { ContentPart, StoredMessage } from './api'

/** The slice of a merchant `/products` entry the cards use (see merchant ProductView). */
export interface Product {
  id: string
  name: string
  brand?: string
  category?: string
  subcategory?: string
  price_cents?: number
  currency?: string
  attributes?: Record<string, string>
  image_url?: string
}

export interface ProductOption {
  optionNumber: number
  product: Product
  merchantIds: string[]
  priceCents: number
  why: string
  tradeoff: string
  topPick: boolean
}

const MAX_OPTIONS = 3

type ToolCall = Extract<ContentPart, { type: 'tool_call' }>
type ToolResult = Extract<ContentPart, { type: 'tool_result' }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every product any search_products call returned in `messages`, by id. Later results win,
 * so a product's details are the freshest the agent saw. */
function productsById(messages: StoredMessage[]): Map<string, Product> {
  const products = new Map<string, Product>()
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'tool_result' || part.name !== 'search_products' || part.isError) continue
      const results = isRecord(part.output) ? part.output.results : undefined
      if (!Array.isArray(results)) continue
      for (const result of results) {
        if (!isRecord(result) || !Array.isArray(result.products)) continue
        for (const product of result.products) {
          if (isRecord(product) && typeof product.id === 'string') {
            products.set(product.id, product as unknown as Product)
          }
        }
      }
    }
  }
  return products
}

/** The last recommendation_plan in `messages` that the server accepted (a rejected call is
 * the model's draft, not what it actually went with). */
function lastAcceptedPlan(messages: StoredMessage[]): Record<string, unknown> | null {
  const failed = new Set<string>()
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool_result' && part.isError) failed.add((part as ToolResult).id)
    }
  }
  let plan: Record<string, unknown> | null = null
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'tool_call') continue
      const call = part as ToolCall
      if (failed.has(call.id)) continue
      // record_recommendation_plan is the current tool; record_audit_event with
      // type "recommendation_plan" is its predecessor, kept so older sessions still render.
      const isPlan =
        call.name === 'record_recommendation_plan' ||
        (call.name === 'record_audit_event' && call.input.type === 'recommendation_plan')
      if (isPlan) plan = call.input
    }
  }
  return plan
}

function toOptions(plan: Record<string, unknown>, products: Map<string, Product>): ProductOption[] {
  const options = Array.isArray(plan.options) ? plan.options : []
  const topPickId =
    typeof plan.highlighted_product_id === 'string' ? plan.highlighted_product_id : null
  return options
    .filter(isRecord)
    .flatMap((option): ProductOption[] => {
      const product =
        typeof option.product_id === 'string' ? products.get(option.product_id) : undefined
      // A product the agent never actually saw in search results can't be shown faithfully.
      if (!product) return []
      return [
        {
          optionNumber: typeof option.option_number === 'number' ? option.option_number : 0,
          product,
          merchantIds: Array.isArray(option.merchant_ids)
            ? option.merchant_ids.filter((m): m is string => typeof m === 'string')
            : [],
          priceCents:
            product.price_cents ??
            (typeof option.price_cents === 'number' ? option.price_cents : 0),
          why: typeof option.why === 'string' ? option.why : '',
          tradeoff: typeof option.tradeoff === 'string' ? option.tradeoff : '',
          topPick: product.id === topPickId,
        },
      ]
    })
    .sort((a, b) => a.optionNumber - b.optionNumber)
    .slice(0, MAX_OPTIONS)
}

/**
 * Product cards per message index: for each user request (a user text message up to the next
 * one), the options from that request's last accepted recommendation_plan, attached to the
 * request's final assistant text message -- the reply the buyer actually reads.
 */
export function productOptionsByMessage(messages: StoredMessage[]): Map<number, ProductOption[]> {
  const byMessage = new Map<number, ProductOption[]>()
  const isUserText = (m: StoredMessage) =>
    m.role === 'user' && m.content.some((part) => part.type === 'text')
  const hasAssistantText = (m: StoredMessage) =>
    m.role === 'assistant' && m.content.some((part) => part.type === 'text')

  let start = 0
  while (start < messages.length) {
    let end = start + 1
    while (end < messages.length && !isUserText(messages[end])) end++

    const turn = messages.slice(start, end)
    const plan = lastAcceptedPlan(turn)
    if (plan) {
      const options = toOptions(plan, productsById(messages.slice(0, end)))
      let replyIndex = -1
      for (let i = end - 1; i >= start; i--) {
        if (hasAssistantText(messages[i])) {
          replyIndex = i
          break
        }
      }
      if (options.length > 0 && replyIndex >= 0) byMessage.set(replyIndex, options)
    }
    start = end
  }
  return byMessage
}
