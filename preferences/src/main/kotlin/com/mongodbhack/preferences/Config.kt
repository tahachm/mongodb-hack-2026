package com.mongodbhack.preferences

/**
 * One process serves the whole preferences store -- nothing to select at startup beyond where
 * MongoDB lives and which Voyage AI model Atlas Vector Search's Automated Embedding should use.
 */
object Config {
    val port: Int = System.getenv("PORT")?.toIntOrNull() ?: 8083

    /** Not a cached `val`: re-read on every call so unrelated config (e.g. embeddingModel for
     * index creation) can be read without requiring MONGODB_URI, and so tests can point this
     * at a throwaway database via the `mongodb.uri` system property. */
    fun mongoUri(): String = System.getenv("MONGODB_URI") ?: System.getProperty("mongodb.uri")
        ?: error("MONGODB_URI env var is required, e.g. mongodb+srv://user:pass@cluster.mongodb.net/")

    val dbName: String = System.getenv("MONGODB_DB") ?: "agentic_commerce"

    /** Voyage AI embedding model Atlas uses for Automated Embedding -- MongoDB generates and
     * manages the vectors server-side, we only ever send/receive raw text. "voyage-4" is
     * MongoDB's recommended balanced default; override to voyage-4-lite for lower cost or
     * voyage-4-large for higher accuracy. */
    val embeddingModel: String = System.getenv("EMBEDDING_MODEL") ?: "voyage-4"

    const val collectionName = "purchase_vectors"
    const val vectorIndexName = "purchase_vector_index"
}
