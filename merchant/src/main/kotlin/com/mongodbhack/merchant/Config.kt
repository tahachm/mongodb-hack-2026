package com.mongodbhack.merchant

/**
 * One process == one merchant. Run this jar N times with different MERCHANT_ID/PORT to bring
 * up N merchants simultaneously, all reading the same catalog.json and filtering by identity.
 */
object Config {
    val merchantId: String = System.getenv("MERCHANT_ID")
        ?: error("MERCHANT_ID env var is required, e.g. mall-wart, somefrills, wellgreens, circuitspree, threadbarn")

    val port: Int = System.getenv("PORT")?.toIntOrNull() ?: 8080

    /** Not a cached `val`: re-read on every call so tests can point this at a throwaway fake
     * PSP per test via the `psp.url` system property, without restarting the JVM. */
    fun pspUrl(): String =
        (System.getenv("PSP_URL") ?: System.getProperty("psp.url") ?: "http://127.0.0.1:8081").trimEnd('/')

    /** When set, the catalog comes from MongoDB Atlas (loaded by tools/load_catalog_to_atlas.py)
     * and /products uses Atlas Vector Search. Unset: the bundled catalog.json with keyword
     * search -- what the tests use, and an offline fallback. */
    val mongoUri: String? = System.getenv("MONGODB_URI")?.takeIf { it.isNotBlank() }

    val dbName: String = System.getenv("MONGODB_DB") ?: "agentic_commerce"

    const val productsCollection = "products"
    const val productIndexName = "product_vector_index"
}
