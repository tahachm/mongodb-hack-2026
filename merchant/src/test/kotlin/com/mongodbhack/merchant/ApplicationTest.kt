package com.mongodbhack.merchant

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
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// MERCHANT_ID must be set to "mall-wart" before Config/Catalog are touched (see build.gradle.kts'
// `environment("MERCHANT_ID", ...)` on the test task) -- these tests use real catalog.json ids
// that are deterministic across regenerations (groceries-00001/00002 are tagged mall-wart;
// groceries-00017 is not).
class ApplicationTest {

    init {
        check(Config.merchantId == "mall-wart") {
            "expected MERCHANT_ID=mall-wart in the test JVM, got '${Config.merchantId}'"
        }
    }

    @Test
    fun `health reports this merchant id`() = testApplication {
        application { module() }
        val response = client.get("/health")
        assertEquals(HttpStatusCode.OK, response.status)
        val body = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertTrue(body["ok"]!!.jsonPrimitive.content.toBoolean())
        assertEquals("mall-wart", body["merchant_id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `products search matches name and ranks by token hits`() = testApplication {
        application { module() }
        val response = client.get("/products?q=spinach")
        assertEquals(HttpStatusCode.OK, response.status)
        val products = Json.parseToJsonElement(response.bodyAsText()).jsonObject["products"]!!.jsonArray
        assertTrue(products.isNotEmpty())
        assertEquals("groceries-00001", products[0].jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `products search never returns items from other merchants`() = testApplication {
        application { module() }
        val response = client.get("/products?q=mangoes")
        val ids = Json.parseToJsonElement(response.bodyAsText()).jsonObject["products"]!!.jsonArray
            .map { it.jsonObject["id"]!!.jsonPrimitive.content }
        assertTrue(ids.contains("groceries-00002"))
        assertTrue(!ids.contains("groceries-00017"))
    }

    @Test
    fun `create_session requires idempotency key`() = testApplication {
        application { module() }
        val response = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            setBody("""{"items": [{"id": "groceries-00001", "quantity": 1}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_idempotency_key", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `create_session prices lines and totals, then replays on retry`() = testApplication {
        application { module() }
        val body = """{"items": [{"id": "groceries-00001", "quantity": 2}, {"id": "groceries-00002", "quantity": 1}]}"""

        val first = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck1")
            setBody(body)
        }
        assertEquals(HttpStatusCode.Created, first.status)
        assertEquals("false", first.headers["Idempotent-Replayed"])
        val session = Json.parseToJsonElement(first.bodyAsText()).jsonObject
        assertEquals("ready_for_payment", session["status"]!!.jsonPrimitive.content)
        // 2 * 849 + 1 * 679 = 2377
        assertEquals(2377, session["totals"]!!.jsonArray.first { it.jsonObject["type"]!!.jsonPrimitive.content == "total" }
            .jsonObject["amount"]!!.jsonPrimitive.content.toInt())
        val sessionId = session["id"]!!.jsonPrimitive.content

        val replay = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck1")
            setBody(body)
        }
        assertEquals("true", replay.headers["Idempotent-Replayed"])
        assertEquals(sessionId, Json.parseToJsonElement(replay.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `create_session rejects an item this merchant does not carry`() = testApplication {
        application { module() }
        val response = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck2")
            setBody("""{"items": [{"id": "groceries-00017", "quantity": 1}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("invalid_item", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `create_session rejects a key reused with a different body`() = testApplication {
        application { module() }
        client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck3")
            setBody("""{"items": [{"id": "groceries-00001", "quantity": 1}]}""")
        }
        val conflict = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck3")
            setBody("""{"items": [{"id": "groceries-00001", "quantity": 2}]}""")
        }
        assertEquals(HttpStatusCode.UnprocessableEntity, conflict.status)
        assertEquals("idempotency_conflict", Json.parseToJsonElement(conflict.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `get_session returns 404 for an unknown id`() = testApplication {
        application { module() }
        val response = client.get("/checkout_sessions/cs_doesnotexist")
        assertEquals(HttpStatusCode.NotFound, response.status)
        assertEquals("not_found", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `update_session re-prices line items`() = testApplication {
        application { module() }
        val created = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck4")
            setBody("""{"items": [{"id": "groceries-00001", "quantity": 1}]}""")
        }
        val sessionId = Json.parseToJsonElement(created.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content

        val updated = client.post("/checkout_sessions/$sessionId") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck5")
            setBody("""{"items": [{"id": "groceries-00002", "quantity": 3}]}""")
        }
        assertEquals(HttpStatusCode.OK, updated.status)
        val total = Json.parseToJsonElement(updated.bodyAsText()).jsonObject["totals"]!!.jsonArray
            .first { it.jsonObject["type"]!!.jsonPrimitive.content == "total" }.jsonObject["amount"]!!.jsonPrimitive.content.toInt()
        assertEquals(679 * 3, total)
    }

    @Test
    fun `cancel_session closes an open session and rejects a second cancel`() = testApplication {
        application { module() }
        val created = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck6")
            setBody("""{"items": [{"id": "groceries-00001", "quantity": 1}]}""")
        }
        val sessionId = Json.parseToJsonElement(created.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content

        val canceled = client.post("/checkout_sessions/$sessionId/cancel") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck7")
            setBody("""{"intent_trace": {"reason": "changed my mind"}}""")
        }
        assertEquals(HttpStatusCode.OK, canceled.status)
        assertEquals("canceled", Json.parseToJsonElement(canceled.bodyAsText()).jsonObject["status"]!!.jsonPrimitive.content)

        val secondCancel = client.post("/checkout_sessions/$sessionId/cancel") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck8")
            setBody("""{}""")
        }
        assertEquals(HttpStatusCode.MethodNotAllowed, secondCancel.status)
        assertEquals("session_closed", Json.parseToJsonElement(secondCancel.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `update_session rejects edits on a canceled session`() = testApplication {
        application { module() }
        val created = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck9")
            setBody("""{"items": [{"id": "groceries-00001", "quantity": 1}]}""")
        }
        val sessionId = Json.parseToJsonElement(created.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content
        client.post("/checkout_sessions/$sessionId/cancel") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck10")
            setBody("""{}""")
        }

        val update = client.post("/checkout_sessions/$sessionId") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck11")
            setBody("""{"items": [{"id": "groceries-00002", "quantity": 1}]}""")
        }
        assertEquals(HttpStatusCode.MethodNotAllowed, update.status)
        assertEquals("session_closed", Json.parseToJsonElement(update.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }
}
