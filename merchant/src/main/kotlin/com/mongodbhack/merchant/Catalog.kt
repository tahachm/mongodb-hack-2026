package com.mongodbhack.merchant

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class CatalogItem(
    val id: String,
    val name: String,
    val brand: String,
    val category: String,
    val subcategory: String,
    val priceCents: Int,
    val currency: String,
    val attributes: Map<String, String> = emptyMap(),
    val merchantIds: List<String>,
)

@Serializable
data class Merchant(
    val id: String,
    val name: String,
    val tagline: String,
)

/**
 * Loads the shared catalog.json / merchants.json bundled on the classpath. catalog.json tags
 * every item with the merchant ids that carry it; filtering by this process's Config.merchantId
 * is what turns one shared file into five independent merchant views.
 */
object Catalog {
    private val json = Json { ignoreUnknownKeys = true }

    val merchants: List<Merchant> by lazy {
        json.decodeFromString<List<Merchant>>(requireResource("/merchants.json"))
    }

    val allItems: List<CatalogItem> by lazy {
        json.decodeFromString<List<CatalogItem>>(requireResource("/catalog.json"))
    }

    fun itemsFor(merchantId: String): List<CatalogItem> =
        allItems.filter { merchantId in it.merchantIds }

    private fun requireResource(path: String): String {
        val stream = Catalog::class.java.getResourceAsStream(path)
            ?: error("catalog resource $path not found on classpath")
        return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }
}
