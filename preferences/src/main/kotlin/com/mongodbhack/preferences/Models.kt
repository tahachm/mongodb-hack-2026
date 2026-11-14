package com.mongodbhack.preferences

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class HealthResponse(val ok: Boolean = true, val service: String = "preferences")

/** One note to store alongside a purchase. `label` lets the caller store several
 * differently-angled notes for the same purchase (e.g. one on the product listing, another on
 * the conversation that led to it) and tell them apart in search results. `text` is raw text --
 * MongoDB Atlas Vector Search auto-embeds it (Voyage AI), so we never see or store a vector. */
@Serializable
data class VectorInput(
    val label: String = "default",
    val text: String,
)

/** Body for `POST /purchases`. One purchase, N vectors (at least one), one product listing,
 * one freeform notes blob -- the notes and listing are shared by every vector in the request. */
@Serializable
data class RecordPurchaseRequest(
    @SerialName("buyer_id") val buyerId: String,
    @SerialName("merchant_id") val merchantId: String? = null,
    val product: JsonElement,
    val notes: String = "",
    val vectors: List<VectorInput> = emptyList(),
)

@Serializable
data class RecordPurchaseResponse(
    @SerialName("purchase_id") val purchaseId: String,
    val created: String,
    @SerialName("vector_count") val vectorCount: Int,
)

/** One semantic query in a bulk lookup. `id` is caller-chosen and just echoed back so the
 * agent can line up `results[i]` with the query it asked, even if the service ever reorders or
 * runs them concurrently. `text` is raw query text -- Atlas auto-embeds it the same way as
 * stored vectors, using the same model, so results are comparable. */
@Serializable
data class SearchQuery(
    val id: String,
    val text: String,
    val limit: Int = 5,
)

/** Body for `POST /purchases/search`. `buyer_id` scopes every query in the batch to one buyer's
 * history (this store is per-buyer preference memory, not a cross-buyer catalog search);
 * `merchant_id` optionally narrows further to purchases made at one merchant. */
@Serializable
data class BulkSearchRequest(
    @SerialName("buyer_id") val buyerId: String,
    @SerialName("merchant_id") val merchantId: String? = null,
    val queries: List<SearchQuery> = emptyList(),
)

@Serializable
data class PurchaseMatch(
    @SerialName("purchase_id") val purchaseId: String,
    val label: String,
    val score: Double,
    @SerialName("merchant_id") val merchantId: String? = null,
    val product: JsonElement,
    val notes: String,
    val created: String,
)

@Serializable
data class SearchQueryResult(val id: String, val matches: List<PurchaseMatch>)

@Serializable
data class BulkSearchResponse(val results: List<SearchQueryResult>)
