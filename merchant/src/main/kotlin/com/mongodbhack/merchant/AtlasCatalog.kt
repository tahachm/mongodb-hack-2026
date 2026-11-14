package com.mongodbhack.merchant

import com.mongodb.client.model.Filters
import com.mongodb.client.model.Projections
import com.mongodb.kotlin.client.coroutine.MongoClient
import com.mongodb.kotlin.client.coroutine.MongoCollection
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.Json
import org.bson.Document

/**
 * The catalog in MongoDB Atlas: the `products` collection that tools/load_catalog_to_atlas.py
 * fills from catalog.json, one document per item (`_id` = item id) plus an `embedding_text`
 * field. Its `product_vector_index` uses Atlas Automated Embedding (Voyage AI), so semantic
 * search here sends plain query text -- no embedding model is called from this process.
 */
class AtlasCatalog(uri: String) {
    private val client = MongoClient.create(uri)
    private val collection: MongoCollection<Document> =
        client.getDatabase(Config.dbName).getCollection(Config.productsCollection)
    private val json = Json { ignoreUnknownKeys = true }

    /** Every item this merchant carries, for pricing and id lookups (loaded once at startup). */
    suspend fun loadItems(merchantId: String): List<CatalogItem> =
        collection.find(Filters.eq("merchantIds", merchantId))
            .projection(Projections.exclude("embedding_text"))
            .toList()
            .map { json.decodeFromString(CatalogItem.serializer(), it.toJson()) }

    /** Ids of this merchant's items closest in meaning to [query], best match first. */
    suspend fun searchIds(merchantId: String, query: String, limit: Int): List<String> {
        val numCandidates = (limit * 10).coerceIn(100, 10_000)
        // Raw stage, same as the preferences service: the driver's Aggregates.vectorSearch()
        // builder only takes precomputed vectors, not Automated Embedding's `query.text`.
        // `merchantIds` is an array; an equality filter matches docs whose array contains it.
        val vectorSearch = Document(
            "\$vectorSearch",
            Document("index", Config.productIndexName)
                .append("path", "embedding_text")
                .append("query", Document("text", query))
                .append("limit", limit)
                .append("numCandidates", numCandidates)
                .append("filter", Document("merchantIds", merchantId)),
        )
        val idsOnly = Document("\$project", Document("_id", 1))
        return collection.aggregate(listOf(vectorSearch, idsOnly)).toList().map { it.getString("_id") }
    }
}
