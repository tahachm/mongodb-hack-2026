package com.mongodbhack.preferences

import com.mongodb.client.model.SearchIndexModel
import com.mongodb.client.model.SearchIndexType
import com.mongodb.kotlin.client.coroutine.MongoClient
import com.mongodb.kotlin.client.coroutine.MongoCollection
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.toList
import org.bson.Document

/**
 * All past-purchase notes, in Atlas, queried with `$vectorSearch`. Each stored document is one
 * (purchase, note) pair: a purchase with N `vectors` in its `RecordPurchaseRequest` becomes N
 * documents here, all sharing `purchase_id`/`product`/`notes` so a vector-search hit on any one
 * of them resolves to the full purchase. We never generate or store an embedding ourselves --
 * the `embedding_text` field is indexed with Atlas Vector Search's Automated Embedding
 * (`autoEmbed`), which sends the text to a Voyage AI model and manages the resulting vector
 * entirely on MongoDB's side. In-process index lifecycle only -- this object owns the
 * MongoClient for the life of the server.
 */
object PurchaseStore {
    private val client = MongoClient.create(Config.mongoUri())
    private val collection: MongoCollection<Document> =
        client.getDatabase(Config.dbName).getCollection(Config.collectionName)

    /**
     * Best-effort: creates the collection and its vector search index if they don't exist yet.
     * Atlas builds search indexes asynchronously, so failures here are logged, not fatal -- the
     * service still starts, `/purchases` still records data, and `/purchases/search` just
     * returns no matches until the index exists and finishes building.
     */
    suspend fun ensureIndex() {
        runCatching { client.getDatabase(Config.dbName).createCollection(Config.collectionName) }
        val existingNames = runCatching { collection.listSearchIndexes().toList() }
            .getOrDefault(emptyList())
            .mapNotNull { it["name"] as? String }
        if (Config.vectorIndexName in existingNames) return
        runCatching {
            collection.createSearchIndexes(listOf(vectorIndexModel())).toList()
        }.onFailure {
            println(
                "[preferences] warning: could not create vector search index '${Config.vectorIndexName}' " +
                    "(it may already be building, or Automated Embedding needs a Voyage AI key configured " +
                    "on this cluster in Atlas -- create it manually if search keeps returning empty): " +
                    it.message
            )
        }
    }

    private fun vectorIndexModel(): SearchIndexModel = SearchIndexModel(
        Config.vectorIndexName,
        Document(
            "fields",
            listOf(
                Document("type", "autoEmbed")
                    .append("path", "embedding_text")
                    .append("model", Config.embeddingModel)
                    .append("modality", "text"),
                Document("type", "filter").append("path", "buyer_id"),
                Document("type", "filter").append("path", "merchant_id"),
            ),
        ),
        SearchIndexType.vectorSearch(),
    )

    /** Inserts one document per note; all share `purchaseId` so a search hit on any one of them
     * can be resolved back to the whole purchase. */
    suspend fun record(purchaseId: String, created: String, req: RecordPurchaseRequest) {
        val productBson = req.product.toBson()
        val docs = req.vectors.map { v ->
            Document()
                .append("purchase_id", purchaseId)
                .append("buyer_id", req.buyerId)
                .append("merchant_id", req.merchantId)
                .append("label", v.label)
                .append("embedding_text", v.text)
                .append("product", productBson)
                .append("notes", req.notes)
                .append("created", created)
        }
        collection.insertMany(docs)
    }

    /** Runs every query in the batch concurrently as its own `$vectorSearch`, scoped to the
     * requested buyer (and optionally merchant), and returns results in the same order as
     * `queries` regardless of which aggregation finishes first. */
    suspend fun search(buyerId: String, merchantId: String?, queries: List<SearchQuery>): List<SearchQueryResult> =
        coroutineScope {
            queries.map { q -> async { SearchQueryResult(q.id, searchOne(buyerId, merchantId, q)) } }
                .map { it.await() }
        }

    private suspend fun searchOne(buyerId: String, merchantId: String?, q: SearchQuery): List<PurchaseMatch> {
        val limit = q.limit.coerceIn(1, 50).toLong()
        val numCandidates = (limit * 10).coerceAtLeast(100).coerceAtMost(10_000)

        // Plain equality fields combine with implicit AND -- no need for an explicit $and.
        val filter = Document("buyer_id", buyerId).apply {
            merchantId?.let { append("merchant_id", it) }
        }

        // Built as a raw stage, not via the Aggregates.vectorSearch() builder: that builder only
        // supports `queryVector` (precomputed floats). Automated Embedding's `query.text` form
        // is newer than this driver's typed helpers, so we speak the wire protocol directly.
        val vectorSearchStage = Document(
            "\$vectorSearch",
            Document("index", Config.vectorIndexName)
                .append("path", "embedding_text")
                .append("query", Document("text", q.text))
                .append("limit", limit)
                .append("numCandidates", numCandidates)
                .append("filter", filter),
        )
        val scoreStage = Document("\$set", Document("score", Document("\$meta", "vectorSearchScore")))

        return collection.aggregate(listOf(vectorSearchStage, scoreStage)).toList().map { it.toMatch() }
    }

    private fun Document.toMatch(): PurchaseMatch = PurchaseMatch(
        purchaseId = getString("purchase_id"),
        label = getString("label"),
        score = (get("score") as Number).toDouble(),
        merchantId = getString("merchant_id"),
        product = get("product").toJsonElement(),
        notes = getString("notes") ?: "",
        created = getString("created"),
    )
}
