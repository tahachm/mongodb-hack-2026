import { MongoClient, type Collection, type Document } from 'mongodb'
import type { ChatSession } from './sessions.js'

/** Identifies which purchase triggered a transcript dump -- pulled straight out of the
 * successful `pay_for_checkout_session` tool_result (see purchaseEventsFrom in app.ts), not
 * re-derived from anything the model said. */
export interface PurchaseTranscriptEvent {
  merchantId: string
  checkoutSessionId: string
  orderId: string | undefined
}

/**
 * Dumps the *entire* raw transcript of a chat session to MongoDB whenever a purchase in it
 * completes -- every turn exactly as recorded in SessionStore: user text, assistant text,
 * tool_call requests, and tool_result responses alike. Nothing is summarized or filtered.
 *
 * Deliberately separate from preferences' `purchase_vectors`: that store holds curated,
 * embedded preference notes for the agent's own semantic recall. This is an unprocessed audit
 * record of what actually happened, for a human (or a future structured-events pipeline) to
 * read later -- the first cut of "structured, auditable events" before anything fancier.
 *
 * One connection for the life of the process, created lazily on first use so a server with no
 * MONGODB_URI configured never tries to dial out. Best-effort like
 * recordPurchasePreferences in tools/acp.ts: a dump failure must never look like the purchase
 * itself failed, so every public method swallows its own errors (logged, not thrown).
 */
export class TranscriptStore {
  private client: MongoClient | undefined
  private collection: Collection<Document> | undefined
  private connecting: Promise<Collection<Document> | undefined> | undefined

  constructor(
    private readonly uri: string | undefined,
    private readonly dbName: string,
    private readonly collectionName: string,
  ) {}

  private async getCollection(): Promise<Collection<Document> | undefined> {
    if (!this.uri) return undefined
    if (this.collection) return this.collection
    // Concurrent purchases before the first connection resolves must share one connect
    // attempt, not each open their own client.
    this.connecting ??= (async () => {
      const client = new MongoClient(this.uri!)
      await client.connect()
      this.client = client
      this.collection = client.db(this.dbName).collection(this.collectionName)
      return this.collection
    })()
    return this.connecting
  }

  async recordPurchase(session: ChatSession, event: PurchaseTranscriptEvent): Promise<void> {
    try {
      const collection = await this.getCollection()
      if (!collection) {
        console.warn(
          `[harness-server] MONGODB_URI not set -- skipping transcript dump for purchase ` +
            `(buyer ${session.id}, checkout session ${event.checkoutSessionId})`,
        )
        return
      }
      await collection.insertOne({
        buyer_id: session.id,
        merchant_id: event.merchantId,
        checkout_session_id: event.checkoutSessionId,
        order_id: event.orderId,
        occurred_at: new Date().toISOString(),
        transcript: session.messages,
      })
    } catch (err) {
      console.error('[harness-server] failed to record purchase transcript', err)
    }
  }

  async close(): Promise<void> {
    await this.client?.close()
  }
}
