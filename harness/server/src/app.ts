import cors from 'cors'
import express from 'express'
import type { LlmClient } from './llm.js'
import { SessionStore } from './sessions.js'

/** Builds the Express app without binding a port, so tests can drive it with supertest and
 * inject a fake LlmClient instead of calling a real model provider. */
export function createApp(llm: LlmClient, sessions: SessionStore = new SessionStore()) {
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
      content,
      createdAt: new Date().toISOString(),
    })

    try {
      const reply = await llm.send(session.messages.map(({ role, content }) => ({ role, content })))
      sessions.appendMessage(session.id, {
        role: 'assistant',
        content: reply,
        createdAt: new Date().toISOString(),
      })
      res.json(session)
    } catch (err) {
      // The user's turn above is already recorded, so a retry resends the same history --
      // same idempotency-by-replay spirit as the merchant/psp mocks, just not key-guarded.
      res.status(502).json({
        error: 'llm_request_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })

  return app
}
