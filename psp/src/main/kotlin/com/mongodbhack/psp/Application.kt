package com.mongodbhack.psp

import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.receive
import io.ktor.server.request.receiveText
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

fun main() {
    println("[psp] mock Agentic Commerce Protocol payment service provider on port ${Config.port}")
    embeddedServer(Netty, port = Config.port, host = "0.0.0.0", module = Application::module).start(wait = true)
}

fun Application.module() {
    install(ContentNegotiation) { json(com.mongodbhack.psp.json) }
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

        // ACP delegate_payment: issues a vt_ token bound to an Allowance. Idempotency-Key
        // required; validation order mirrors the old mock exactly (payment method type,
        // then missing allowance fields, then allowance.reason).
        post("/agentic_commerce/delegate_payment") {
            val rawBody = call.receiveText()
            val root = runCatching { com.mongodbhack.psp.json.parseToJsonElement(rawBody).jsonObject }.getOrNull()
            if (root == null) {
                call.respondJsonError(HttpStatusCode.BadRequest, "invalid_json", "request body must be a JSON object")
                return@post
            }
            call.idempotent("delegate_payment", rawBody) { delegatePayment(root) }
        }

        // Internal contract with the merchant mocks (not part of the ACP spec): redeem a
        // token at checkout completion. The merchant's own Idempotency-Key wrapper on
        // /complete already guarantees this runs at most once per real attempt, so no
        // idempotency handling is needed here.
        post("/tokens/{id}/redeem") {
            val tokenId = call.parameters["id"]
            val req = call.receive<RedeemRequest>()
            call.respond(TokenStore.redeem(tokenId, req.merchantId, req.checkoutSessionId, req.amount, req.currency))
        }
    }
}

private fun delegatePayment(root: JsonObject): Pair<HttpStatusCode, JsonElement> {
    val paymentMethod = root["payment_method"]?.jsonObject
    val type = paymentMethod?.get("type")?.jsonPrimitive?.contentOrNull
    if (type != "card") {
        return HttpStatusCode.BadRequest to apiError("invalid_payment_method", "only card supported", param = "$.payment_method.type")
    }

    val allowanceJson = root["allowance"]?.jsonObject
    val required = listOf("reason", "max_amount", "currency", "checkout_session_id", "merchant_id", "expires_at")
    val missing = required.filter { allowanceJson?.containsKey(it) != true }
    if (allowanceJson == null || missing.isNotEmpty()) {
        return HttpStatusCode.BadRequest to apiError(
            "missing_allowance_field",
            "allowance missing $missing",
            param = "$.allowance.${missing.firstOrNull() ?: ""}",
        )
    }

    val reason = allowanceJson.getValue("reason").jsonPrimitive.content
    if (reason != "one_time") {
        return HttpStatusCode.BadRequest to apiError("invalid_allowance_reason", "only one_time supported", param = "$.allowance.reason")
    }

    val allowance = com.mongodbhack.psp.json.decodeFromJsonElement(Allowance.serializer(), allowanceJson)
    val tokenId = "vt_" + randomHex(10)
    val last4 = (paymentMethod["number"]?.jsonPrimitive?.contentOrNull ?: "0000").takeLast(4)
    TokenStore.put(tokenId, TokenRecord(allowance = allowance, created = nowIso(), last4 = last4))

    val metadata = buildJsonObject {
        (root["metadata"] as? JsonObject)?.forEach { (k, v) -> put(k, v) }
        put("psp", "mockpsp")
    }
    val body = buildJsonObject {
        put("id", tokenId)
        put("created", nowIso())
        put("metadata", metadata)
    }
    return HttpStatusCode.Created to body
}
