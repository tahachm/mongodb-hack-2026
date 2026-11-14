package com.mongodbhack.psp

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respondText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

/** ACP-shaped error body: `{type, code, message, param?}`. */
fun apiError(code: String, message: String, type: String = "invalid_request", param: String? = null): JsonElement =
    buildJsonObject {
        put("type", type)
        put("code", code)
        put("message", message)
        if (param != null) put("param", param)
    }

suspend fun ApplicationCall.respondJsonError(
    status: HttpStatusCode,
    code: String,
    message: String,
    type: String = "invalid_request",
    param: String? = null,
) {
    respondText(
        json.encodeToString(JsonElement.serializer(), apiError(code, message, type, param)),
        ContentType.Application.Json,
        status,
    )
}
