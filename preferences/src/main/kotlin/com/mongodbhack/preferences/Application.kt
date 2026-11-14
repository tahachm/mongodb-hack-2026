package com.mongodbhack.preferences

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
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

fun main() {
    runBlocking { PurchaseStore.ensureIndex() }
    println(
        "[preferences] past-purchase vector store on port ${Config.port}, db '${Config.dbName}', " +
            "Atlas Automated Embedding model '${Config.embeddingModel}'"
    )
    embeddedServer(Netty, port = Config.port, host = "0.0.0.0", module = Application::module).start(wait = true)
}

fun Application.module() {
    install(ContentNegotiation) { json(com.mongodbhack.preferences.json) }
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
            call.respond(HealthResponse())
        }

        // Record purchase: the agent calls this right after a checkout completes. One or more
        // raw-text notes (we embed nothing ourselves -- Atlas Automated Embedding does, from
        // `embedding_text`), the product listing that was bought, and freeform notes from the
        // conversation that led to it.
        post("/purchases") {
            val rawBody = call.receiveText()
            val req = runCatching { json.decodeFromString(RecordPurchaseRequest.serializer(), rawBody) }.getOrNull()
            if (req == null) {
                call.respondJsonError(HttpStatusCode.BadRequest, "invalid_json", "request body must be valid JSON")
                return@post
            }
            call.idempotent("record", rawBody) { recordPurchase(req) }
        }

        // Bulk semantic lookup: the agent calls this to recall past purchases by semantic
        // qualities (e.g. "something like what they bought for a picnic last time"). Several
        // query vectors in one round trip, each scored independently against this buyer's
        // (optionally one merchant's) purchase history.
        post("/purchases/search") {
            val rawBody = call.receiveText()
            val req = runCatching { json.decodeFromString(BulkSearchRequest.serializer(), rawBody) }.getOrNull()
            if (req == null) {
                call.respondJsonError(HttpStatusCode.BadRequest, "invalid_json", "request body must be valid JSON")
                return@post
            }
            call.idempotent("search", rawBody) { bulkSearch(req) }
        }
    }
}

private fun validateVectorText(text: String, param: String): JsonElement? {
    if (text.isBlank()) {
        return apiError("missing_vector_text", "text must not be blank", param = param)
    }
    return null
}

private suspend fun recordPurchase(req: RecordPurchaseRequest): Pair<HttpStatusCode, JsonElement> {
    if (req.buyerId.isBlank()) {
        return HttpStatusCode.BadRequest to apiError("missing_buyer_id", "buyer_id is required", param = "$.buyer_id")
    }
    if (req.product !is JsonObject) {
        return HttpStatusCode.BadRequest to apiError("invalid_product", "product must be a JSON object", param = "$.product")
    }
    if (req.vectors.isEmpty()) {
        return HttpStatusCode.BadRequest to apiError("missing_vectors", "at least one vector is required", param = "$.vectors")
    }
    req.vectors.forEachIndexed { i, v ->
        validateVectorText(v.text, "$.vectors[$i].text")?.let { return HttpStatusCode.BadRequest to it }
    }

    val purchaseId = "pur_" + randomHex(10)
    val created = nowIso()
    PurchaseStore.record(purchaseId, created, req)
    return HttpStatusCode.Created to json.encodeToJsonElement(
        RecordPurchaseResponse.serializer(),
        RecordPurchaseResponse(purchaseId, created, req.vectors.size),
    )
}

private suspend fun bulkSearch(req: BulkSearchRequest): Pair<HttpStatusCode, JsonElement> {
    if (req.buyerId.isBlank()) {
        return HttpStatusCode.BadRequest to apiError("missing_buyer_id", "buyer_id is required", param = "$.buyer_id")
    }
    if (req.queries.isEmpty()) {
        return HttpStatusCode.BadRequest to apiError("missing_queries", "at least one query is required", param = "$.queries")
    }
    req.queries.forEachIndexed { i, q ->
        if (q.id.isBlank()) {
            return HttpStatusCode.BadRequest to apiError("missing_query_id", "query id is required", param = "$.queries[$i].id")
        }
        validateVectorText(q.text, "$.queries[$i].text")?.let { return HttpStatusCode.BadRequest to it }
    }

    val results = PurchaseStore.search(req.buyerId, req.merchantId, req.queries)
    return HttpStatusCode.OK to json.encodeToJsonElement(BulkSearchResponse.serializer(), BulkSearchResponse(results))
}
