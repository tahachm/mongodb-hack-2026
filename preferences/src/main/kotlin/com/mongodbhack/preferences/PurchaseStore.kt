package com.mongodbhack.preferences

import com.mongodb.client.model.Aggregates
import com.mongodb.client.model.Filters
import com.mongodb.client.model.SearchIndexModel
import com.mongodb.client.model.SearchIndexType
import com.mongodb.client.model.search.SearchPath
import com.mongodb.client.model.search.VectorSearchOptions
import com.mongodb.kotlin.client.coroutine.MongoClient
import com.mongodb.kotlin.client.coroutine.MongoCollection
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.toList
import org.bson.Document
import org.bson.conversions.Bson

/**
 * All past-purchase embeddings, in Atlas, queried with `$vectorSearch`. Each stored document is
 * one (purchase, vector) pair: a purchase with N `vectors` in its `RecordPurchaseRequest` becomes
 * N documents here, all sharing `purchase_id`/`product`/`notes` so a vector-search hit on any one
 * of them resolves to the full purchase. In-process index lifecycle only -- this object owns the
 * MongoClient for the life of the server.
 */
object PurchaseStore {
    private val client = MongoClient.create(Config.mongoUri())
    private val collection: MongoCollection<Document> =
        client.getDatabase(Config.dbName).getCollection(Config.collectionName)

    /**
     * Best-effort: creates the collection and its vector search index if they don't exist yet.
     * Atlas builds search indexes asynchronously (and Atlas Search index management needs a
     * dedicated/serverless tier or M10+), so failures here are logged, not fatal -- the service
     * still starts, `/purchases` still records data, and `/purchases/search` just returns no
     * matches until the index exists and finishes building.
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
                    "(it may already be building, or this cluster tier doesn't support managing it here -- " +
                    "create it manually in Atlas if search keeps returning empty): ${it.message}"
            )
        }
    }

    private fun vectorIndexModel(): SearchIndexModel = SearchIndexModel(
        Config.vectorIndexName,
        Document(
            "fields",
            listOf(
                Document("type", "vector")
                    .append("path", "embedding")
                    .append("numDimensions", Config.embeddingDimensions)
                    .append("similarity", "cosine"),
                Document("type", "filter").append("path", "buyer_id"),
                Document("type", "filter").append("path", "merchant_id"),
            ),
        ),
        SearchIndexType.vectorSearch(),
    )

    /** Inserts one document per vector; all share `purchaseId` so a search hit on any vector
     * can be resolved back to the whole purchase. */
    suspend fun record(purchaseId: String, created: String, req: RecordPurchaseRequest) {
        val productBson = req.product.toBson()
        val docs = req.vectors.map { v ->
            Document()
                .append("purchase_id", purchaseId)
                .append("buyer_id", req.buyerId)
                .append("merchant_id", req.merchantId)
                .append("label", v.label)
                .append("embedding", v.embedding.map { it.toDouble() })
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

        val filters: List<Bson> = buildList {
            add(Filters.eq("buyer_id", buyerId))
            merchantId?.let { add(Filters.eq("merchant_id", it)) }
        }
        val filter: Bson = if (filters.size == 1) filters[0] else Filters.and(filters)

        val vectorSearchStage = Aggregates.vectorSearch(
            SearchPath.fieldPath("embedding"),
            q.embedding.map { it.toDouble() },
            Config.vectorIndexName,
            limit,
            VectorSearchOptions.approximateVectorSearchOptions(numCandidates).filter(filter),
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
