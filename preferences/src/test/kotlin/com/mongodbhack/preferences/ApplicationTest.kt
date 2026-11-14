package com.mongodbhack.preferences

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Covers request validation and Idempotency-Key handling only -- every case here returns
 * before `PurchaseStore` is touched, so none of it needs a live MongoDB connection (same spirit
 * as merchant/psp: no external dependency in the test suite). Actually recording a purchase or
 * running `$vectorSearch` against Atlas is exercised manually against a real cluster, not here --
 * Atlas Search index builds (and Automated Embedding's own async sync) are asynchronous, so a
 * round trip through a freshly created index would be flaky by construction, not a real bug in
 * this service.
 */
class ApplicationTest {

    private fun recordBody(buyerId: String = "cust_1", notes: String = "n") = """
        {"buyer_id": "$buyerId", "product": {"id": "sku_1", "name": "Widget"}, "notes": "$notes",
         "vectors": [{"label": "default", "text": "likes blue, budget conscious"}]}
    """.trimIndent()

    @Test
    fun `health reports ok`() = testApplication {
        application { module() }
        val response = client.get("/health")
        assertEquals(HttpStatusCode.OK, response.status)
        assertTrue(Json.parseToJsonElement(response.bodyAsText()).jsonObject["ok"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `purchases requires idempotency key`() = testApplication {
        application { module() }
        val response = client.post("/purchases") {
            contentType(ContentType.Application.Json)
            setBody(recordBody())
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_idempotency_key", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `purchases replays identical retries via Idempotency-Key`() = testApplication {
        application { module() }
        val body = recordBody(buyerId = "") // invalid on purpose: stays within validation, never touches Mongo
        val first = client.post("/purchases") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k1")
            setBody(body)
        }
        val second = client.post("/purchases") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k1")
            setBody(body)
        }
        assertEquals(HttpStatusCode.BadRequest, first.status)
        assertEquals("false", first.headers["Idempotent-Replayed"])
        assertEquals(first.bodyAsText(), second.bodyAsText())
        assertEquals("true", second.headers["Idempotent-Replayed"])
    }

    @Test
    fun `purchases rejects key reuse with a different body`() = testApplication {
        application { module() }
        client.post("/purchases") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k2")
            setBody(recordBody(buyerId = ""))
        }
        val second = client.post("/purchases") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k2")
            setBody(recordBody(buyerId = "", notes = "different"))
        }
        assertEquals(HttpStatusCode.UnprocessableEntity, second.status)
        assertEquals("idempotency_conflict", Json.parseToJsonElement(second.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `purchases rejects invalid json`() = testApplication {
        application { module() }
        val response = client.post("/purchases") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k3")
            setBody("not json")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("invalid_json", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `purchases rejects missing buyer_id`() = testApplication {
        application { module() }
        val response = client.post("/purchases") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k4")
            setBody(recordBody(buyerId = ""))
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_buyer_id", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `purchases rejects a non-object product`() = testApplication {
        application { module() }
        val response = client.post("/purchases") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k5")
            setBody("""{"buyer_id": "cust_1", "product": "sku_1", "vectors": [{"text": "note"}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("invalid_product", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `purchases rejects an empty vectors list`() = testApplication {
        application { module() }
        val response = client.post("/purchases") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k6")
            setBody("""{"buyer_id": "cust_1", "product": {"id": "sku_1"}, "vectors": []}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_vectors", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `purchases rejects a vector with blank text`() = testApplication {
        application { module() }
        val response = client.post("/purchases") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k7")
            setBody("""{"buyer_id": "cust_1", "product": {"id": "sku_1"}, "vectors": [{"text": "  "}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        val error = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals("missing_vector_text", error["code"]!!.jsonPrimitive.content)
        assertEquals("\$.vectors[0].text", error["param"]!!.jsonPrimitive.content)
    }

    @Test
    fun `search requires idempotency key`() = testApplication {
        application { module() }
        val response = client.post("/purchases/search") {
            contentType(ContentType.Application.Json)
            setBody("""{"buyer_id": "cust_1", "queries": []}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_idempotency_key", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `search rejects missing buyer_id`() = testApplication {
        application { module() }
        val response = client.post("/purchases/search") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k8")
            setBody("""{"buyer_id": "", "queries": [{"id": "q1", "text": "toilet paper"}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_buyer_id", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `search rejects an empty queries list`() = testApplication {
        application { module() }
        val response = client.post("/purchases/search") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k9")
            setBody("""{"buyer_id": "cust_1", "queries": []}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_queries", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `search rejects a query with a blank id`() = testApplication {
        application { module() }
        val response = client.post("/purchases/search") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k10")
            setBody("""{"buyer_id": "cust_1", "queries": [{"id": "", "text": "toilet paper"}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_query_id", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `search rejects a query with blank text`() = testApplication {
        application { module() }
        val response = client.post("/purchases/search") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k11")
            setBody("""{"buyer_id": "cust_1", "queries": [{"id": "q1", "text": ""}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        val error = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals("missing_vector_text", error["code"]!!.jsonPrimitive.content)
        assertEquals("\$.queries[0].text", error["param"]!!.jsonPrimitive.content)
    }
}
