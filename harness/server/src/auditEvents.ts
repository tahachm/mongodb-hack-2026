import { createHash } from 'node:crypto'
import { MongoClient, type Collection, type Document } from 'mongodb'
import { randomUuidV7 } from './uuid.js'

/** Where a `record_history_insights`/`record_recommendation_plan` call is scoped --
 * `sessionId` and `buyerId` are the same value in this harness today (one chat session is
 * one buyer), but stored as separate fields since the audit log is conceptually a per-buyer
 * ledger, not a per-session one. */
export interface AuditEventContext {
  sessionId: string
  buyerId: string
}

/** The two event shapes `record_history_insights`/`record_recommendation_plan` accept --
 * only the fields this store needs to resolve run membership. See parseHistoryInsights/
 * parseRecommendationPlan in tools/acp.ts for full validation; this store trusts its caller
 * already validated `event` and persists `rawInput` byte-for-byte as the payload ("the
 * model's input verbatim", per agent-system-prompt.md's header comment). */
export type AuditEventLink =
  | { type: 'history_insights'; updatesEventId: string | null }
  | { type: 'recommendation_plan'; insightsEventId: string }

interface AuditEventDocument extends Document {
  event_id: string
  session_id: string
  buyer_id: string
  run_id: string
  seq: number
  at: string
  type: string
  payload: Record<string, unknown>
  prev_hash: string
  hash: string
}

/**
 * Persists every `record_history_insights`/`record_recommendation_plan` call to MongoDB's
 * `audit_events` collection -- the collection from plan/PLAN.md section 5.2 referenced in
 * agent-system-prompt.md's header comment (`history_insights` = `preferences_inferred`,
 * `recommendation_plan` = `recommendation_made` there). Unlike TranscriptStore, this is not
 * best-effort: it's the actual audit record the rest of the design depends on, so a write
 * failure (including MONGODB_URI not being configured) throws and surfaces to the model as a
 * normal tool failure -- agent-system-prompt.md section 5.1/7.3 already tell the model what to
 * do when this call fails ("tell the user you can't save your reasoning right now").
 *
 * Two things this store adds beyond a plain insert:
 * - `run_id`: a `history_insights` event with no `updates_event_id` starts a new run; every
 *   other event (a revised `history_insights`, or a `recommendation_plan`) joins the run of
 *   the event it references, resolved here by looking that event up.
 * - A hash chain (`prev_hash`/`hash`), one continuous chain per `buyer_id`: each event's hash
 *   covers its own content plus the previous event's hash, so altering or removing a past
 *   event (the log is otherwise just an app-level "don't" -- Mongo itself still allows writes)
 *   changes every hash after it, visible to anyone who re-walks the chain.
 *
 * Writes for the same buyer are serialized through an in-process queue (`enqueue`) so two
 * `record_history_insights`/`record_recommendation_plan` calls racing in the same assistant turn can't both read the same "last
 * event" and corrupt the chain -- there's no multi-document transaction doing this instead.
 */
export class AuditEventStore {
  private client: MongoClient | undefined
  private collection: Collection<AuditEventDocument> | undefined
  private connecting: Promise<Collection<AuditEventDocument>> | undefined
  private queues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly uri: string | undefined,
    private readonly dbName: string,
    private readonly collectionName: string,
  ) {}

  private async getCollection(): Promise<Collection<AuditEventDocument>> {
    if (!this.uri) {
      throw new Error(
        'record_history_insights/record_recommendation_plan is unavailable: MONGODB_URI is not configured on harness-server',
      )
    }
    if (this.collection) return this.collection
    // Concurrent first calls must share one connect attempt, not each open their own client.
    this.connecting ??= (async () => {
      const client = new MongoClient(this.uri!)
      await client.connect()
      this.client = client
      const collection = client.db(this.dbName).collection<AuditEventDocument>(this.collectionName)
      await collection.createIndex({ event_id: 1 }, { unique: true })
      await collection.createIndex({ buyer_id: 1, seq: 1 })
      this.collection = collection
      return collection
    })()
    return this.connecting
  }

  /** Runs `task` after every previously enqueued task for this `buyerId` has settled --
   * success or failure -- so a failed write never wedges the queue for later calls. */
  private enqueue<T>(buyerId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(buyerId) ?? Promise.resolve()
    const run = prior.then(task, task)
    // Swallow here so one rejected run doesn't poison `queues` for the next caller -- the
    // real rejection still propagates to whoever awaited `run` (this method's return value).
    this.queues.set(
      buyerId,
      run.catch(() => undefined),
    )
    return run
  }

  private genesisHash(buyerId: string): string {
    return createHash('sha256').update(`audit_events genesis:${buyerId}`).digest('hex')
  }

  async record(
    rawInput: Record<string, unknown>,
    link: AuditEventLink,
    context: AuditEventContext,
  ): Promise<{ event_id: string; seq: number }> {
    return this.enqueue(context.buyerId, async () => {
      const collection = await this.getCollection()

      const referencedId =
        link.type === 'history_insights' ? link.updatesEventId : link.insightsEventId
      let runId: string
      if (referencedId) {
        const referenced = await collection.findOne({
          event_id: referencedId,
          buyer_id: context.buyerId,
        })
        if (!referenced) {
          const field = link.type === 'history_insights' ? 'updates_event_id' : 'insights_event_id'
          throw new Error(
            `record_history_insights/record_recommendation_plan: ${field} "${referencedId}" does not match any earlier event for this buyer`,
          )
        }
        runId = referenced.run_id
      } else {
        runId = randomUuidV7()
      }

      const last = await collection
        .find({ buyer_id: context.buyerId })
        .sort({ seq: -1 })
        .limit(1)
        .next()
      const seq = (last?.seq ?? 0) + 1
      const prevHash = last?.hash ?? this.genesisHash(context.buyerId)

      const eventId = randomUuidV7()
      const doc: Omit<AuditEventDocument, 'hash' | '_id'> = {
        event_id: eventId,
        session_id: context.sessionId,
        buyer_id: context.buyerId,
        run_id: runId,
        seq,
        at: new Date().toISOString(),
        type: link.type,
        payload: rawInput,
        prev_hash: prevHash,
      }
      const hash = createHash('sha256').update(JSON.stringify(doc)).digest('hex')
      await collection.insertOne({ ...doc, hash } as AuditEventDocument)

      return { event_id: eventId, seq }
    })
  }

  async close(): Promise<void> {
    await this.client?.close()
  }
}
