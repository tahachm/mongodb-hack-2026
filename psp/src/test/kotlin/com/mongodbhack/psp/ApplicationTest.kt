package com.mongodbhack.psp

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
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ApplicationTest {

    private fun delegateBody(
        maxAmount: Long = 10_000,
        checkoutSessionId: String = "cs_1",
        merchantId: String = "mall-wart",
        currency: String = "usd",
        expiresAt: String = Instant.now().plusSeconds(600).toString(),
        reason: String = "one_time",
        paymentType: String = "card",
    ) = """
        {"payment_method": {"type": "$paymentType", "number": "4242424242424242"},
         "allowance": {"reason": "$reason", "max_amount": $maxAmount, "currency": "$currency",
                       "checkout_session_id": "$checkoutSessionId", "merchant_id": "$merchantId",
                       "expires_at": "$expiresAt"},
         "risk_signals": [], "metadata": {"run_id": "r1"}}
    """.trimIndent()

    @Test
    fun `health reports ok`() = testApplication {
        application { module() }
        val response = client.get("/health")
        assertEquals(HttpStatusCode.OK, response.status)
        assertTrue(Json.parseToJsonElement(response.bodyAsText()).jsonObject["ok"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `delegate_payment requires idempotency key`() = testApplication {
        application { module() }
        val response = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            setBody(delegateBody())
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_idempotency_key", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `delegate_payment issues a vt token and replays on retry`() = testApplication {
        application { module() }
        val body = delegateBody()

        val first = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k1")
            setBody(body)
        }
        assertEquals(HttpStatusCode.Created, first.status)
        assertEquals("false", first.headers["Idempotent-Replayed"])
        val firstJson = Json.parseToJsonElement(first.bodyAsText()).jsonObject
        val tokenId = firstJson["id"]!!.jsonPrimitive.content
        assertTrue(tokenId.startsWith("vt_"))

        val replay = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k1")
            setBody(body)
        }
        assertEquals(HttpStatusCode.Created, replay.status)
        assertEquals("true", replay.headers["Idempotent-Replayed"])
        assertEquals(tokenId, Json.parseToJsonElement(replay.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `delegate_payment rejects key reuse with a different body`() = testApplication {
        application { module() }
        client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k2")
            setBody(delegateBody(maxAmount = 1_000))
        }
        val conflict = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k2")
            setBody(delegateBody(maxAmount = 2_000))
        }
        assertEquals(HttpStatusCode.UnprocessableEntity, conflict.status)
        assertEquals("idempotency_conflict", Json.parseToJsonElement(conflict.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `delegate_payment rejects non-card payment methods`() = testApplication {
        application { module() }
        val response = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k3")
            setBody(delegateBody(paymentType = "bank_transfer"))
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("invalid_payment_method", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `delegate_payment rejects missing allowance fields`() = testApplication {
        application { module() }
        val response = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k4")
            setBody("""{"payment_method": {"type": "card"}, "allowance": {"reason": "one_time"}}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("missing_allowance_field", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `delegate_payment rejects non one_time allowance reason`() = testApplication {
        application { module() }
        val response = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k5")
            setBody(delegateBody(reason = "recurring"))
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("invalid_allowance_reason", Json.parseToJsonElement(response.bodyAsText()).jsonObject["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun `redeem succeeds once then fails as already used`() = testApplication {
        application { module() }
        val issued = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k6")
            setBody(delegateBody(maxAmount = 5_000, checkoutSessionId = "cs_6", merchantId = "mall-wart"))
        }
        val tokenId = Json.parseToJsonElement(issued.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content

        val redeemBody = """{"merchant_id": "mall-wart", "checkout_session_id": "cs_6", "amount": 5000, "currency": "usd"}"""
        val first = client.post("/tokens/$tokenId/redeem") {
            contentType(ContentType.Application.Json)
            setBody(redeemBody)
        }
        val firstResult = Json.parseToJsonElement(first.bodyAsText()).jsonObject
        assertTrue(firstResult["ok"]!!.jsonPrimitive.content.toBoolean())

        val second = client.post("/tokens/$tokenId/redeem") {
            contentType(ContentType.Application.Json)
            setBody(redeemBody)
        }
        val secondResult = Json.parseToJsonElement(second.bodyAsText()).jsonObject
        assertFalse(secondResult["ok"]!!.jsonPrimitive.content.toBoolean())
        assertTrue(secondResult["reason"]!!.jsonPrimitive.content.contains("already used"))
    }

    @Test
    fun `redeem rejects wrong merchant, wrong session, over-ceiling amount and unknown token`() = testApplication {
        application { module() }
        val issued = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k7")
            setBody(delegateBody(maxAmount = 1_000, checkoutSessionId = "cs_7", merchantId = "mall-wart"))
        }
        val tokenId = Json.parseToJsonElement(issued.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content

        suspend fun redeem(merchantId: String, sessionId: String, amount: Long) =
            client.post("/tokens/$tokenId/redeem") {
                contentType(ContentType.Application.Json)
                setBody("""{"merchant_id": "$merchantId", "checkout_session_id": "$sessionId", "amount": $amount, "currency": "usd"}""")
            }.let { Json.parseToJsonElement(it.bodyAsText()).jsonObject }

        assertFalse(redeem("somefrills", "cs_7", 1_000)["ok"]!!.jsonPrimitive.content.toBoolean())
        assertFalse(redeem("mall-wart", "cs_other", 1_000)["ok"]!!.jsonPrimitive.content.toBoolean())
        assertFalse(redeem("mall-wart", "cs_7", 1_001)["ok"]!!.jsonPrimitive.content.toBoolean())

        val unknown = client.post("/tokens/vt_doesnotexist/redeem") {
            contentType(ContentType.Application.Json)
            setBody("""{"merchant_id": "mall-wart", "checkout_session_id": "cs_7", "amount": 1000, "currency": "usd"}""")
        }
        val unknownResult = Json.parseToJsonElement(unknown.bodyAsText()).jsonObject
        assertFalse(unknownResult["ok"]!!.jsonPrimitive.content.toBoolean())
        assertEquals("unknown payment token", unknownResult["reason"]!!.jsonPrimitive.content)
    }

    @Test
    fun `redeem rejects an expired allowance`() = testApplication {
        application { module() }
        val issued = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k8")
            setBody(
                delegateBody(
                    checkoutSessionId = "cs_8",
                    expiresAt = Instant.now().minus(1, ChronoUnit.HOURS).toString(),
                ),
            )
        }
        val tokenId = Json.parseToJsonElement(issued.bodyAsText()).jsonObject["id"]!!.jsonPrimitive.content

        val response = client.post("/tokens/$tokenId/redeem") {
            contentType(ContentType.Application.Json)
            setBody("""{"merchant_id": "mall-wart", "checkout_session_id": "cs_8", "amount": 1000, "currency": "usd"}""")
        }
        val result = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertFalse(result["ok"]!!.jsonPrimitive.content.toBoolean())
        assertEquals("allowance expired", result["reason"]!!.jsonPrimitive.content)
    }

    @Test
    fun `delegate_payment includes psp metadata alongside caller metadata`() = testApplication {
        application { module() }
        val response = client.post("/agentic_commerce/delegate_payment") {
            contentType(ContentType.Application.Json)
            header("Idempotency-Key", "k9")
            setBody(delegateBody())
        }
        val metadata = Json.parseToJsonElement(response.bodyAsText()).jsonObject["metadata"]!!.jsonObject
        assertEquals("mockpsp", metadata["psp"]!!.jsonPrimitive.content)
        assertEquals("r1", metadata["run_id"]!!.jsonPrimitive.content)
    }
}
