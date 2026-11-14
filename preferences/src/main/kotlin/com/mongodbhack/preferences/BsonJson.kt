package com.mongodbhack.preferences

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.bson.Document

/**
 * The buyer-facing "product" listing and the notes/matches we hand back are freeform JSON, not
 * a fixed schema -- same spirit as merchant/psp passing `buyer`/`intent_trace` through as opaque
 * `JsonElement`. MongoDB storage and the driver's aggregation builders speak BSON, so these two
 * functions are the only place that crosses between the two worlds.
 */
fun JsonElement.toBson(): Any? = when (this) {
    is JsonNull -> null
    is JsonObject -> Document(entries.associate { (k, v) -> k to v.toBson() })
    is JsonArray -> map { it.toBson() }
    is JsonPrimitive -> when {
        isString -> content
        content == "true" || content == "false" -> content.toBoolean()
        else -> content.toDoubleOrNull() ?: content
    }
}

@Suppress("UNCHECKED_CAST")
fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is Document -> JsonObject(mapValues { (_, v) -> v.toJsonElement() })
    is Map<*, *> -> JsonObject((this as Map<String, Any?>).mapValues { (_, v) -> v.toJsonElement() })
    is List<*> -> JsonArray(map { it.toJsonElement() })
    is String -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    else -> JsonPrimitive(toString())
}
