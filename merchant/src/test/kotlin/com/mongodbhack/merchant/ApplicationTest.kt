package com.mongodbhack.merchant

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.response.respondText
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// MERCHANT_ID must be set to "mall-wart" before Config/Catalog are touched (see build.gradle.kts'
// `environment("MERCHANT_ID", ...)` on the test task) -- these tests use real catalog.json ids,
// which tools/amazon_catalog.py reproduces deterministically. If the catalog is regenerated
// from different source data, update these fixtures.

/** Carried by mall-wart; the only catalog item whose name contains [ITEM_A_QUERY]. */
private const val ITEM_A = "B07CN556CZ" // 327th Airborne Infantry Regiment Patch Recon
private const val ITEM_A_PRICE = 1050
private const val ITEM_A_QUERY = "airborne"

/** Carried by mall-wart; the only mall-wart item matching [ITEM_B_QUERY]. */
private const val ITEM_B = "B09VC4GPPN" // Montana West Bling Collection Ladies Sunglasses
private const val ITEM_B_PRICE = 1999
private const val ITEM_B_QUERY = "montana"

/** Also matches [ITEM_B_QUERY], but only threadbarn carries it -- never visible to mall-wart. */
private const val OTHER_MERCHANT_ITEM = "B09M728N79" // Montana West Handbags for Women

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
        val response = client.get("/products?q=$ITEM_A_QUERY")
        assertEquals(HttpStatusCode.OK, response.status)
        val products = Json.parseToJsonElement(response.bodyAsText()).jsonObject["products"]!!.jsonArray
        assertTrue(products.isNotEmpty())
        assertEquals(ITEM_A, products[0].jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `products search never returns items from other merchants`() = testApplication {
        application { module() }
        val response = client.get("/products?q=$ITEM_B_QUERY")
        val ids = Json.parseToJsonElement(response.bodyAsText()).jsonObject["products"]!!.jsonArray
            .map { it.jsonObject["id"]!!.jsonPrimitive.content }
        assertTrue(ids.contains(ITEM_B))
        assertTrue(!ids.contains(OTHER_MERCHANT_ITEM))
    }

    @Test
    fun `create_session requires idempotency key`() = testApplication {
        application { module() }
        val response = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            setBody("""{"items": [{"id": "$ITEM_A", "quantity": 1}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_idempotency_key", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `create_session prices lines and totals, then replays on retry`() = testApplication {
        application { module() }
        val body = """{"items": [{"id": "$ITEM_A", "quantity": 2}, {"id": "$ITEM_B", "quantity": 1}]}"""

        val first = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck1")
            setBody(body)
        }
        assertEquals(HttpStatusCode.Created, first.status)
        assertEquals("false", first.headers["Idempotent-Replayed"])
        val session = Json.parseToJsonElement(first.bodyAsText()).jsonObject
        assertEquals("ready_for_payment", session["status"]!!.jsonPrimitive.content)
        assertEquals(ITEM_A_PRICE * 2 + ITEM_B_PRICE, session["totals"]!!.jsonArray.first { it.jsonObject["type"]!!.jsonPrimitive.content == "total" }
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
            setBody("""{"items": [{"id": "$OTHER_MERCHANT_ITEM", "quantity": 1}]}""")
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
            setBody("""{"items": [{"id": "$ITEM_A", "quantity": 1}]}""")
        }
        val conflict = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck3")
            setBody("""{"items": [{"id": "$ITEM_A", "quantity": 2}]}""")
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
            setBody("""{"items": [{"id": "$ITEM_A", "quantity": 1}]}""")
        }
        val sessionId = Json.parseToJsonElement(created.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content

        val updated = client.post("/checkout_sessions/$sessionId") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck5")
            setBody("""{"items": [{"id": "$ITEM_B", "quantity": 3}]}""")
        }
        assertEquals(HttpStatusCode.OK, updated.status)
        val total = Json.parseToJsonElement(updated.bodyAsText()).jsonObject["totals"]!!.jsonArray
            .first { it.jsonObject["type"]!!.jsonPrimitive.content == "total" }.jsonObject["amount"]!!.jsonPrimitive.content.toInt()
        assertEquals(ITEM_B_PRICE * 3, total)
    }

    @Test
    fun `cancel_session closes an open session and rejects a second cancel`() = testApplication {
        application { module() }
        val created = client.post("/checkout_sessions") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "ck6")
            setBody("""{"items": [{"id": "$ITEM_A", "quantity": 1}]}""")
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
            setBody("""{"items": [{"id": "$ITEM_A", "quantity": 1}]}""")
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
            setBody("""{"items": [{"id": "$ITEM_B", "quantity": 1}]}""")
        }
        assertEquals(HttpStatusCode.MethodNotAllowed, update.status)
        assertEquals("session_closed", Json.parseToJsonElement(update.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    /** Starts a throwaway fake PSP on `port` that always answers /tokens/{id}/redeem with
     * `outcome`, points Config.pspUrl() at it for the duration of `block`, then tears both
     * down. Each test picks its own port so they can run (and fail) independently. */
    private fun withFakePsp(outcome: RedeemOutcome, port: Int, block: () -> Unit) {
        val server = embeddedServer(Netty, port = port) {
            routing {
                post("/tokens/{id}/redeem") {
                    call.respondText(json.encodeToString(RedeemOutcome.serializer(), outcome), ContentType.Application.Json)
                }
            }
        }
        server.start(wait = false)
        System.setProperty("psp.url", "http://127.0.0.1:$port")
        try {
            block()
        } finally {
            server.stop(100, 200)
            System.clearProperty("psp.url")
        }
    }

    @Test
    fun `complete_session marks the session completed when the PSP approves`() = withFakePsp(RedeemOutcome(true, "ok"), 28101) {
        testApplication {
            application { module() }
            val created = client.post("/checkout_sessions") {
                contentType(ContentType.Application.Json)
                header("Idempotency-Key", "cp1")
                setBody("""{"items": [{"id": "$ITEM_A", "quantity": 1}]}""")
            }
            val sessionId = Json.parseToJsonElement(created.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content

            val completed = client.post("/checkout_sessions/$sessionId/complete") {
                contentType(ContentType.Application.Json)
                header("Idempotency-Key", "cp2")
                setBody("""{"payment_data": {"token": "vt_whatever"}}""")
            }
            assertEquals(HttpStatusCode.OK, completed.status)
            val body = Json.parseToJsonElement(completed.bodyAsText()).jsonObject
            assertEquals("completed", body["status"]!!.jsonPrimitive.content)
            assertEquals(sessionId, body["order"]!!.jsonObject["checkout_session_id"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun `complete_session is declined when the PSP rejects the token`() =
        withFakePsp(RedeemOutcome(false, "amount exceeds allowance max_amount 100"), 28102) {
            testApplication {
                application { module() }
                val created = client.post("/checkout_sessions") {
                    contentType(ContentType.Application.Json)
                    header("Idempotency-Key", "cp3")
                    setBody("""{"items": [{"id": "$ITEM_A", "quantity": 1}]}""")
                }
                val sessionId = Json.parseToJsonElement(created.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content

                val completed = client.post("/checkout_sessions/$sessionId/complete") {
                    contentType(ContentType.Application.Json)
                    header("Idempotency-Key", "cp4")
                    setBody("""{"payment_data": {"token": "vt_whatever"}}""")
                }
                assertEquals(HttpStatusCode.PaymentRequired, completed.status)
                val body = Json.parseToJsonElement(completed.bodyAsText()).jsonObject
                assertEquals("payment_declined", body["code"]!!.jsonPrimitive.content)
                assertTrue(body["message"]!!.jsonPrimitive.content.contains("exceeds allowance"))

                // declined payment leaves the session open for a retry with a fresh token
                val session = client.get("/checkout_sessions/$sessionId")
                assertEquals("ready_for_payment", Json.parseToJsonElement(session.bodyAsText()).jsonObject["status"]!!.jsonPrimitive.content)
            }
        }

    @Test
    fun `complete_session returns 503 when the PSP is unreachable`() = testApplication {
        application { module() }
        System.setProperty("psp.url", "http://127.0.0.1:28103") // nothing listening here
        try {
            val created = client.post("/checkout_sessions") {
                contentType(ContentType.Application.Json)
                header("Idempotency-Key", "cp5")
                setBody("""{"items": [{"id": "$ITEM_A", "quantity": 1}]}""")
            }
            val sessionId = Json.parseToJsonElement(created.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content

            val completed = client.post("/checkout_sessions/$sessionId/complete") {
                contentType(ContentType.Application.Json)
                header("Idempotency-Key", "cp6")
                setBody("""{"payment_data": {"token": "vt_whatever"}}""")
            }
            assertEquals(HttpStatusCode.ServiceUnavailable, completed.status)
            assertEquals(
                "payment_provider_unavailable",
                Json.parseToJsonElement(completed.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content,
            )
        } finally {
            System.clearProperty("psp.url")
        }
    }

    @Test
    fun `complete_session rejects a session that is not ready_for_payment`() =
        withFakePsp(RedeemOutcome(true, "ok"), 28104) {
            testApplication {
                application { module() }
                val created = client.post("/checkout_sessions") {
                    contentType(ContentType.Application.Json)
                    header("Idempotency-Key", "cp7")
                    setBody("""{"items": [{"id": "$ITEM_A", "quantity": 1}]}""")
                }
                val sessionId = Json.parseToJsonElement(created.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content
                client.post("/checkout_sessions/$sessionId/cancel") {
                    contentType(ContentType.Application.Json)
                    header("Idempotency-Key", "cp8")
                    setBody("""{}""")
                }

                val completed = client.post("/checkout_sessions/$sessionId/complete") {
                    contentType(ContentType.Application.Json)
                    header("Idempotency-Key", "cp9")
                    setBody("""{"payment_data": {"token": "vt_whatever"}}""")
                }
                assertEquals(HttpStatusCode.MethodNotAllowed, completed.status)
                assertEquals(
                    "session_closed",
                    Json.parseToJsonElement(completed.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content,
                )
            }
        }

}
