package com.mongodbhack.merchant

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
private data class RedeemRequestBody(
    @SerialName("merchant_id") val merchantId: String,
    @SerialName("checkout_session_id") val checkoutSessionId: String,
    val amount: Long,
    val currency: String,
)

/** Mirrors PSP's RedeemResult. Not shared code -- merchant and psp are separate Gradle
 * projects/processes; this is the contract between them, duplicated on purpose. */
@Serializable
data class RedeemOutcome(val ok: Boolean, val reason: String)

private val pspHttpClient by lazy {
    HttpClient(CIO) {
        install(ContentNegotiation) { json(com.mongodbhack.merchant.json) }
    }
}

/**
 * Calls the PSP mock to redeem a `vt_` token at checkout completion. Not part of the ACP
 * spec -- an internal contract now that merchant and PSP run as separate processes instead
 * of sharing one in-process call. Throws on network failure or a non-2xx response; callers
 * should treat that as "couldn't reach the payment provider" (503), distinct from the PSP's
 * own 200 `{ok: false, reason}` for a token that's simply invalid/expired/already used.
 */
suspend fun redeemToken(tokenId: String, checkoutSessionId: String, amountCents: Long, currency: String): RedeemOutcome {
    val response = pspHttpClient.post("${Config.pspUrl()}/tokens/$tokenId/redeem") {
        contentType(ContentType.Application.Json)
        setBody(RedeemRequestBody(Config.merchantId, checkoutSessionId, amountCents, currency))
    }
    return response.body()
}
