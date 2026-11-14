import { MongoClient, type Db, type Document } from 'mongodb'

/** One audit event as the inspection view needs it -- the stored document minus its Mongo
 * `_id` and hash-chain fields, which say nothing about the reasoning itself. */
export interface InspectAuditEvent {
  event_id: string
  run_id: string
  seq: number
  at: string
  type: string
  payload: Record<string, unknown>
}

/** One saved preference record, merged from its per-label purchase_vectors documents
 * (preferences stores request/comparison/decision as separate embedded docs that share a
 * purchase_id and the same notes). */
export interface InspectRecord {
  purchase_id: string
  merchant_id: string | null
  notes: string
  product: Record<string, unknown> | null
  created: string | null
}

export interface InspectData {
  /** False when no MONGODB_URI is configured -- the view says so instead of an empty graph. */
  available: boolean
  events: InspectAuditEvent[]
  records: InspectRecord[]
}

export interface InspectSource {
  load(sessionId: string): Promise<InspectData>
}

/** Ids of the saved records the session's history_insights events cite, as evidence or as
 * ignored -- the only purchase_vectors documents the graph draws. */
function citedRecordIds(events: InspectAuditEvent[]): string[] {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== 'history_insights') continue
    const { insights, ignored_records: ignored } = event.payload
    if (Array.isArray(insights)) {
      for (const insight of insights) {
        const evidence = (insight as { evidence?: unknown })?.evidence
        if (!Array.isArray(evidence)) continue
        for (const id of evidence) if (typeof id === 'string') ids.add(id)
      }
    }
    if (Array.isArray(ignored)) {
      for (const entry of ignored) {
        const id = (entry as { record_id?: unknown })?.record_id
        if (typeof id === 'string') ids.add(id)
      }
    }
  }
  return [...ids]
}

/**
 * Read-only view over what the agent recorded for one chat session: its audit_events (the
 * reasoning) and the purchase_vectors records those events cite (the evidence). Backs
 * GET /sessions/:id/inspect. Lazily connects once, like TranscriptStore.
 */
export class MongoInspectSource implements InspectSource {
  private connecting: Promise<Db> | undefined

  constructor(
    private readonly uri: string | undefined,
    private readonly dbName: string,
    private readonly auditEventsCollection: string,
    private readonly recordsCollection: string,
  ) {}

  private db(): Promise<Db> {
    this.connecting ??= (async () => {
      const client = new MongoClient(this.uri!)
      await client.connect()
      return client.db(this.dbName)
    })()
    // A failed connect shouldn't stick: let the next request try again.
    this.connecting.catch(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  async load(sessionId: string): Promise<InspectData> {
    if (!this.uri) return { available: false, events: [], records: [] }
    const db = await this.db()

    const events = await db
      .collection(this.auditEventsCollection)
      .find(
        { session_id: sessionId },
        { projection: { _id: 0, event_id: 1, run_id: 1, seq: 1, at: 1, type: 1, payload: 1 } },
      )
      .sort({ seq: 1 })
      .toArray()
    const auditEvents = events as unknown as InspectAuditEvent[]

    const ids = citedRecordIds(auditEvents)
    const records = new Map<string, InspectRecord>()
    if (ids.length > 0) {
      const docs = await db
        .collection(this.recordsCollection)
        .find({ purchase_id: { $in: ids } }, { projection: { _id: 0, embedding: 0 } })
        .toArray()
      for (const doc of docs as Document[]) {
        const id = doc.purchase_id as string
        if (records.has(id)) continue
        records.set(id, {
          purchase_id: id,
          merchant_id: (doc.merchant_id as string | null) ?? null,
          notes: typeof doc.notes === 'string' ? doc.notes : '',
          product:
            doc.product && Object.keys(doc.product as object).length > 0
              ? (doc.product as Record<string, unknown>)
              : null,
          created: doc.created ? new Date(doc.created as string).toISOString() : null,
        })
      }
    }

    return { available: true, events: auditEvents, records: [...records.values()] }
  }
}
