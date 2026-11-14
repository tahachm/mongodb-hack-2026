package com.mongodbhack.preferences

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respondText
import kotlinx.serialization.json.JsonElement
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

private data class IdempotentRecord(val bodyHash: String, val status: Int, val payload: String)

private sealed class Replay {
    data class Miss(val bodyHash: String) : Replay()
    data class Hit(val status: Int, val payload: String) : Replay()
    data object Conflict : Replay()
}

/**
 * Per-process Idempotency-Key store. `scope` namespaces routes so two endpoints can't collide
 * on the same key. Same (scope, key) + same body replays the stored response; same key + a
 * different body is a 422 conflict. Mirrors ACP's Idempotency-Key semantics (see merchant/psp).
 */
private object IdempotencyStore {
    private val records = ConcurrentHashMap<String, IdempotentRecord>()

    fun sha256Hex(body: String): String =
        MessageDigest.getInstance("SHA-256").digest(body.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    fun check(scope: String, key: String, rawBody: String): Replay {
        val hash = sha256Hex(rawBody)
        val existing = records["$scope:$key"] ?: return Replay.Miss(hash)
        return if (existing.bodyHash == hash) Replay.Hit(existing.status, existing.payload) else Replay.Conflict
    }

    fun store(scope: String, key: String, bodyHash: String, status: Int, payload: String) {
        records["$scope:$key"] = IdempotentRecord(bodyHash, status, payload)
    }
}

/**
 * Wraps a POST handler with Idempotency-Key semantics. `block` runs at most once per
 * (scope, key, body) and its result is cached; replays set `Idempotent-Replayed: true`, first
 * runs set it `false`. A missing key or a key reused with a different body short-circuits
 * before `block` ever runs.
 */
suspend fun ApplicationCall.idempotent(
    scope: String,
    rawBody: String,
    block: suspend () -> Pair<HttpStatusCode, JsonElement>,
) {
    val key = request.headers["Idempotency-Key"]
    if (key.isNullOrBlank()) {
        respondJsonError(HttpStatusCode.BadRequest, "missing_idempotency_key", "Idempotency-Key header is required on POST")
        return
    }
    when (val replay = IdempotencyStore.check(scope, key, rawBody)) {
        is Replay.Conflict ->
            respondJsonError(HttpStatusCode.UnprocessableEntity, "idempotency_conflict", "Idempotency-Key reused with a different request body")
        is Replay.Hit -> {
            response.headers.append("Idempotent-Replayed", "true")
            respondText(replay.payload, ContentType.Application.Json, HttpStatusCode.fromValue(replay.status))
        }
        is Replay.Miss -> {
            val (status, body) = block()
            val payload = json.encodeToString(JsonElement.serializer(), body)
            IdempotencyStore.store(scope, key, replay.bodyHash, status.value, payload)
            response.headers.append("Idempotent-Replayed", "false")
            respondText(payload, ContentType.Application.Json, status)
        }
    }
}
