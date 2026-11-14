package com.mongodbhack.preferences

/**
 * One process serves the whole preferences store -- nothing to select at startup beyond where
 * MongoDB lives and how big the embedding vectors the agent will send us are.
 */
object Config {
    val port: Int = System.getenv("PORT")?.toIntOrNull() ?: 8083

    /** Not a cached `val`: re-read on every call so unrelated config (e.g. embeddingDimensions
     * for request validation) can be read without requiring MONGODB_URI, and so tests can
     * point this at a throwaway database via the `mongodb.uri` system property. */
    fun mongoUri(): String = System.getenv("MONGODB_URI") ?: System.getProperty("mongodb.uri")
        ?: error("MONGODB_URI env var is required, e.g. mongodb+srv://user:pass@cluster.mongodb.net/")

    val dbName: String = System.getenv("MONGODB_DB") ?: "agentic_commerce"

    /** Atlas Vector Search indexes are fixed-width: every stored vector and every query vector
     * must have exactly this many dimensions. Defaults to 768 (e.g. Gemini's text-embedding-004),
     * override to match whatever embedding model the agent actually calls. */
    val embeddingDimensions: Int = System.getenv("EMBEDDING_DIMENSIONS")?.toIntOrNull() ?: 768

    const val collectionName = "purchase_vectors"
    const val vectorIndexName = "purchase_vector_index"
}
