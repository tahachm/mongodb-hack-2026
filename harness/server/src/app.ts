import cors from 'cors'
import express from 'express'
import { runAgentTurn, type ToolExecutor } from './agent.js'
import { AuditEventStore } from './auditEvents.js'
import { config } from './config.js'
import { MongoInspectSource, type InspectSource } from './inspect.js'
import type { ContentPart, LlmClient, Turn } from './llm.js'
import { SessionStore } from './sessions.js'
import { SYSTEM_PROMPT } from './systemPrompt.js'
import { acpTools, createAcpToolExecutor } from './tools/acp.js'
import { TranscriptStore, type PurchaseTranscriptEvent } from './transcripts.js'

// One AuditEventStore (and so one lazily-opened Mongo connection) for the whole process --
// every session's ToolExecutor shares it, since the store is already buyer-scoped internally
// (see auditEvents.ts) and its hash chain needs one connection serializing writes per buyer,
// not one per session.
let sharedAuditEvents: AuditEventStore | undefined
function defaultAuditEventStore(): AuditEventStore {
  sharedAuditEvents ??= new AuditEventStore(
    config.mongoUri,
    config.mongoDb,
    config.auditEventsCollection,
  )
  return sharedAuditEvents
}

/** One executor per chat session, not a shared singleton -- `buyer_id` on every recorded
 * purchase is the harness chat session id, so preferences and audit events recorded in one
 * conversation stay scoped to it. Cached per session (see toolExecutors below) rather than
 * rebuilt on every message, just to avoid the churn -- correctness no longer depends on it
 * the way it would if the audit log's sequencing lived in this closure instead of Mongo. */
function defaultCreateToolExecutor(buyerId: string): ToolExecutor {
  return createAcpToolExecutor(
    config.merchants,
    config.pspUrl,
    { baseUrl: config.preferencesUrl, buyerId },
    defaultAuditEventStore(),
  )
}

function defaultTranscriptStore(): TranscriptStore {
  return new TranscriptStore(config.mongoUri, config.mongoDb, config.transcriptsCollection)
}

function defaultInspectSource(): InspectSource {
  return new MongoInspectSource(
    config.mongoUri,
    config.mongoDb,
    config.auditEventsCollection,
    config.purchaseVectorsCollection,
  )
}

function isToolResult(part: ContentPart): part is Extract<ContentPart, { type: 'tool_result' }> {
  return part.type === 'tool_result'
}

/** Pulls merchant_id / checkout_session_id / order_id out of every successful
 * `pay_for_checkout_session` tool_result among `turns` -- see payForCheckoutSession in
 * tools/acp.ts for the shape it returns (the merchant's CheckoutSession, flattened). A
 * failed call (isError) never triggers a dump. */
function purchaseEventsFrom(turns: Turn[]): PurchaseTranscriptEvent[] {
  const events: PurchaseTranscriptEvent[] = []
  for (const turn of turns) {
    for (const part of turn.content) {
      if (!isToolResult(part) || part.name !== 'pay_for_checkout_session' || part.isError) {
        continue
      }
      const output = part.output
      if (typeof output !== 'object' || output === null) continue
      const o = output as Record<string, unknown>
      const merchantId = typeof o.merchant_id === 'string' ? o.merchant_id : undefined
      const checkoutSessionId = typeof o.id === 'string' ? o.id : undefined
      if (!merchantId || !checkoutSessionId) continue
      const order = o.order as Record<string, unknown> | null | undefined
      const orderId = typeof order?.id === 'string' ? order.id : undefined
      events.push({ merchantId, checkoutSessionId, orderId })
    }
  }
  return events
}

/** Builds the Express app without binding a port, so tests can drive it with supertest and
 * inject a fake LlmClient/ToolExecutor instead of calling a real model provider or the real
 * merchant/psp services. */
export function createApp(
  llm: LlmClient,
  createToolExecutor: (buyerId: string) => ToolExecutor = defaultCreateToolExecutor,
  sessions: SessionStore = new SessionStore(),
  transcripts: TranscriptStore = defaultTranscriptStore(),
  inspect: InspectSource = defaultInspectSource(),
) {
  const app = express()
  app.use(cors())
  app.use(express.json())

  // One ToolExecutor per session, reused for every message in it -- see the comment on
  // defaultCreateToolExecutor above.
  const toolExecutors = new Map<string, ToolExecutor>()
  function getToolExecutor(buyerId: string): ToolExecutor {
    let executor = toolExecutors.get(buyerId)
    if (!executor) {
      executor = createToolExecutor(buyerId)
      toolExecutors.set(buyerId, executor)
    }
    return executor
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.post('/sessions', (_req, res) => {
    res.status(201).json(sessions.create())
  })

  app.get('/sessions', (_req, res) => {
    res.json(sessions.list())
  })

  app.get('/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id)
    if (!session) {
      res.status(404).json({ error: 'session_not_found' })
      return
    }
    res.json(session)
  })

  // The inspection view's data: what the agent recorded about its reasoning in this session
  // (audit_events) plus the saved preference records that reasoning cites (purchase_vectors).
  // Doesn't require the in-memory session, so a session's reasoning stays inspectable after a
  // server restart as long as the client still knows its id.
  app.get('/sessions/:id/inspect', async (req, res) => {
    try {
      res.json(await inspect.load(req.params.id))
    } catch (err) {
      res.status(502).json({
        error: 'inspect_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })

  app.post('/sessions/:id/messages', async (req, res) => {
    const session = sessions.get(req.params.id)
    if (!session) {
      res.status(404).json({ error: 'session_not_found' })
      return
    }

    const content = req.body?.content
    if (typeof content !== 'string' || content.trim() === '') {
      res
        .status(400)
        .json({ error: 'invalid_content', message: 'content must be a non-empty string' })
      return
    }

    sessions.appendMessage(session.id, {
      role: 'user',
      content: [{ type: 'text', text: content }],
      createdAt: new Date().toISOString(),
    })

    try {
      const history = session.messages.map(({ role, content }) => ({ role, content }))
      const executeTool = getToolExecutor(session.id)
      const newTurns: Turn[] = []
      await runAgentTurn(llm, SYSTEM_PROMPT, acpTools, history, executeTool, (turn) => {
        newTurns.push(turn)
        sessions.appendMessage(session.id, { ...turn, createdAt: new Date().toISOString() })
      })
      const finalSession = sessions.get(session.id)!
      // Dump the whole transcript (tool calls and results included) once per purchase that
      // just completed in this request -- not on every later message in the same session.
      for (const event of purchaseEventsFrom(newTurns)) {
        await transcripts.recordPurchase(finalSession, event)
      }
      res.json(finalSession)
    } catch (err) {
      // Everything the agent loop already completed before this failure (e.g. earlier tool
      // calls in the same turn) was already persisted via onTurn above, so a retry doesn't
      // lose it -- same idempotency-by-replay spirit as the merchant/psp mocks, just not
      // key-guarded here.
      res.status(502).json({
        error: 'llm_request_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })

  return app
}
