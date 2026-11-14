import cors from 'cors'
import express from 'express'
import { runAgentTurn, type ToolExecutor } from './agent.js'
import { config } from './config.js'
import { createGeminiEmbedder, createUnavailableEmbedder } from './embeddings.js'
import type { LlmClient } from './llm.js'
import { SessionStore } from './sessions.js'
import { SYSTEM_PROMPT } from './systemPrompt.js'
import { acpTools, createAcpToolExecutor } from './tools/acp.js'

const embedder = config.embeddingApiKey
  ? createGeminiEmbedder(config.embeddingApiKey, config.embeddingModel, config.embeddingDimensions)
  : createUnavailableEmbedder(
      'GEMINI_API_KEY is required to embed preference_notes for pay_for_checkout_session',
    )

/** One executor per chat session, not a shared singleton -- `buyer_id` on every recorded
 * purchase is the harness chat session id, so preferences recorded in one conversation stay
 * scoped to it. */
function defaultCreateToolExecutor(buyerId: string): ToolExecutor {
  return createAcpToolExecutor(config.merchants, config.pspUrl, {
    baseUrl: config.preferencesUrl,
    buyerId,
    embedder,
  })
}

/** Builds the Express app without binding a port, so tests can drive it with supertest and
 * inject a fake LlmClient/ToolExecutor instead of calling a real model provider or the real
 * merchant/psp services. */
export function createApp(
  llm: LlmClient,
  createToolExecutor: (buyerId: string) => ToolExecutor = defaultCreateToolExecutor,
  sessions: SessionStore = new SessionStore(),
) {
  const app = express()
  app.use(cors())
  app.use(express.json())

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
      const executeTool = createToolExecutor(session.id)
      await runAgentTurn(llm, SYSTEM_PROMPT, acpTools, history, executeTool, (turn) => {
        sessions.appendMessage(session.id, { ...turn, createdAt: new Date().toISOString() })
      })
      res.json(sessions.get(session.id))
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
