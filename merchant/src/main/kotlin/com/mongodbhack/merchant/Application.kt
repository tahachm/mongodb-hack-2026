package com.mongodbhack.merchant

import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.receiveText
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject

fun main() {
    val merchant = Catalog.merchants.find { it.id == Config.merchantId }
        ?: error(
            "Unknown MERCHANT_ID '${Config.merchantId}'. Known merchants: " +
                Catalog.merchants.joinToString { it.id }
        )
    val items = Catalog.itemsFor(Config.merchantId)
    val byCategory = items.groupingBy { it.category }.eachCount().toSortedMap()
    println(
        "[${merchant.name}] (${Config.merchantId}) loaded ${items.size} / ${Catalog.allItems.size} " +
            "catalog items on port ${Config.port} -- categories: $byCategory"
    )

    embeddedServer(Netty, port = Config.port, host = "0.0.0.0", module = Application::module).start(wait = true)
}

fun Application.module() {
    install(ContentNegotiation) { json(com.mongodbhack.merchant.json) }
    install(StatusPages) {
        exception<Throwable> { call, cause ->
            call.respondJsonError(
                HttpStatusCode.InternalServerError,
                "internal_error",
                cause.message ?: cause::class.simpleName ?: "unknown error",
                type = "service_unavailable",
            )
        }
    }

    routing {
        get("/health") {
            call.respond(HealthResponse(merchantId = Config.merchantId))
        }

        get("/products") {
            val q = call.request.queryParameters["q"] ?: ""
            call.respond(searchProducts(q))
        }

        // ACP checkout_sessions: create / get / update / cancel. `complete` (payment) is
        // implemented separately once it talks to the PSP mock for token redemption.
        post("/checkout_sessions") {
            val rawBody = call.receiveText()
            val req = runCatching { json.decodeFromString(CreateSessionRequest.serializer(), rawBody) }.getOrNull()
            if (req == null) {
                call.respondJsonError(HttpStatusCode.BadRequest, "invalid_json", "request body must be valid JSON")
                return@post
            }
            call.idempotent("create", rawBody) { createSession(req) }
        }

        get("/checkout_sessions/{id}") {
            val id = call.parameters["id"]!!
            val session = SessionStore.get(id)
            if (session == null) {
                call.respondJsonError(HttpStatusCode.NotFound, "not_found", "checkout session $id not found")
                return@get
            }
            call.respond(session)
        }

        post("/checkout_sessions/{id}") {
            val id = call.parameters["id"]!!
            val rawBody = call.receiveText()
            val req = runCatching { json.decodeFromString(UpdateSessionRequest.serializer(), rawBody) }.getOrNull()
            if (req == null) {
                call.respondJsonError(HttpStatusCode.BadRequest, "invalid_json", "request body must be valid JSON")
                return@post
            }
            call.idempotent("update:$id", rawBody) { updateSession(id, req) }
        }

        post("/checkout_sessions/{id}/cancel") {
            val id = call.parameters["id"]!!
            val rawBody = runCatching { call.receiveText() }.getOrDefault("")
            val intentTrace = runCatching {
                json.parseToJsonElement(rawBody.ifBlank { "{}" }).jsonObject["intent_trace"]
            }.getOrNull()
            call.idempotent("cancel:$id", rawBody) { cancelSession(id, intentTrace) }
        }
    }
}

private fun searchProducts(q: String): ProductsResponse {
    val tokens = q.lowercase().replace("\"", " ").split(Regex("\\s+")).filter { it.length > 1 }
    val catalog = Catalog.itemsFor(Config.merchantId)
    val scored = catalog.map { item ->
        val haystack = "${item.name} ${item.brand} ${item.category} ${item.subcategory} " +
            item.attributes.values.joinToString(" ")
        val lower = haystack.lowercase()
        item to tokens.count { t -> lower.contains(t) || lower.contains(t.trimEnd('s')) }
    }
    val matches = if (tokens.isEmpty()) scored else scored.filter { it.second > 0 }
    val sorted = matches.sortedByDescending { it.second }.map { it.first.toProductView() }
    return ProductsResponse(Config.merchantId, sorted)
}

/** Prices requested items against this merchant's catalog slice. Returns either the priced
 * lines, or an ACP-shaped error naming the first bad item/quantity -- never both. */
private fun priceLines(items: List<ItemRef>): Pair<List<LineItem>?, JsonElement?> {
    val products = Catalog.itemsFor(Config.merchantId).associateBy { it.id }
    val lines = mutableListOf<LineItem>()
    items.forEachIndexed { i, ref ->
        val p = products[ref.id]
            ?: return null to apiError("invalid_item", "unknown item ${ref.id}", param = "$.items[$i].id")
        if (ref.quantity < 1) {
            return null to apiError("invalid_quantity", "quantity must be >= 1", param = "$.items[$i].quantity")
        }
        lines += LineItem(
            id = "li_$i",
            item = ItemRef(p.id, ref.quantity),
            title = p.name,
            category = p.category,
            baseAmount = p.priceCents * ref.quantity,
            unitAmount = p.priceCents,
            total = p.priceCents * ref.quantity,
        )
    }
    return lines to null
}

private fun totals(lines: List<LineItem>): List<Total> {
    val sub = lines.sumOf { it.total }
    return listOf(Total("subtotal", sub), Total("total", sub))
}

private fun createSession(req: CreateSessionRequest): Pair<HttpStatusCode, JsonElement> {
    val (lines, err) = priceLines(req.items)
    if (err != null) return HttpStatusCode.BadRequest to err
    val session = CheckoutSession(
        id = "cs_" + randomHex(8),
        merchantId = Config.merchantId,
        status = "ready_for_payment",
        buyer = req.buyer,
        lineItems = lines!!,
        totals = totals(lines),
        created = nowIso(),
    )
    SessionStore.put(session)
    return HttpStatusCode.Created to json.encodeToJsonElement(CheckoutSession.serializer(), session)
}

private fun updateSession(id: String, req: UpdateSessionRequest): Pair<HttpStatusCode, JsonElement> {
    val existing = SessionStore.get(id) ?: return HttpStatusCode.NotFound to apiError("not_found", "session not found")
    if (existing.status == "completed" || existing.status == "canceled") {
        return HttpStatusCode.MethodNotAllowed to apiError("session_closed", "session is ${existing.status}")
    }
    val updated = if (req.items != null) {
        val (lines, err) = priceLines(req.items)
        if (err != null) return HttpStatusCode.BadRequest to err
        existing.copy(lineItems = lines!!, totals = totals(lines))
    } else {
        existing
    }
    SessionStore.put(updated)
    return HttpStatusCode.OK to json.encodeToJsonElement(CheckoutSession.serializer(), updated)
}

private fun cancelSession(id: String, intentTrace: JsonElement?): Pair<HttpStatusCode, JsonElement> {
    val existing = SessionStore.get(id) ?: return HttpStatusCode.NotFound to apiError("not_found", "session not found")
    if (existing.status == "completed" || existing.status == "canceled") {
        return HttpStatusCode.MethodNotAllowed to apiError("session_closed", "session is ${existing.status}")
    }
    val canceled = existing.copy(status = "canceled", cancelIntentTrace = intentTrace)
    SessionStore.put(canceled)
    return HttpStatusCode.OK to json.encodeToJsonElement(CheckoutSession.serializer(), canceled)
}
