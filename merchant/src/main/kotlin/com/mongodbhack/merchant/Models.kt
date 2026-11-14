package com.mongodbhack.merchant

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class HealthResponse(val ok: Boolean = true, @SerialName("merchant_id") val merchantId: String)

/** A catalog item's view of itself, as served over `/products`: every field a buyer-facing
 * feed needs, minus `merchantIds` (which exists only to let this shared catalog back five
 * processes -- not relevant to a buyer talking to one of them). */
@Serializable
data class ProductView(
    val id: String,
    val name: String,
    val brand: String,
    val category: String,
    val subcategory: String,
    @SerialName("price_cents") val priceCents: Int,
    val currency: String,
    val attributes: Map<String, String> = emptyMap(),
)

fun CatalogItem.toProductView() = ProductView(id, name, brand, category, subcategory, priceCents, currency, attributes)

@Serializable
data class ProductsResponse(@SerialName("merchant_id") val merchantId: String, val products: List<ProductView>)

/** One requested line: a catalog item id and how many. `quantity` defaults to 1 so a bare
 * `{"id": "..."}` in a request body is valid, same as the old mock. */
@Serializable
data class ItemRef(val id: String, val quantity: Int = 1)

@Serializable
data class LineItem(
    val id: String,
    val item: ItemRef,
    val title: String,
    val category: String,
    @SerialName("base_amount") val baseAmount: Int,
    @SerialName("unit_amount") val unitAmount: Int,
    val tax: Int = 0,
    val total: Int,
)

@Serializable
data class Total(val type: String, val amount: Int)

@Serializable
data class Order(
    val id: String,
    @SerialName("checkout_session_id") val checkoutSessionId: String,
    @SerialName("permalink_url") val permalinkUrl: String,
)

/** ACP checkout session. Immutable -- every transition (`update`, `complete`, `cancel`)
 * produces a new copy that replaces the old one in `SessionStore`, so there's never a
 * partially-mutated session visible to a concurrent reader. */
@Serializable
data class CheckoutSession(
    val id: String,
    @SerialName("merchant_id") val merchantId: String,
    val status: String,
    val currency: String = "usd",
    val buyer: JsonElement? = null,
    @SerialName("line_items") val lineItems: List<LineItem>,
    val totals: List<Total>,
    val created: String,
    val order: Order? = null,
    @SerialName("cancel_intent_trace") val cancelIntentTrace: JsonElement? = null,
)

@Serializable
data class CreateSessionRequest(val items: List<ItemRef> = emptyList(), val buyer: JsonElement? = null)

@Serializable
data class UpdateSessionRequest(val items: List<ItemRef>? = null)

@Serializable
data class PaymentData(val token: String)

@Serializable
data class CompleteSessionRequest(@SerialName("payment_data") val paymentData: PaymentData)
