package com.mongodbhack.psp

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.util.concurrent.atomic.AtomicBoolean

@Serializable
data class HealthResponse(val ok: Boolean = true, val service: String = "psp")

/**
 * ACP Allowance: scopes a delegated payment token to one merchant, one checkout session, a
 * currency and a hard ceiling, with an expiry. Mirrors the ACP 2026-04-17 spec's
 * `delegate_payment` allowance object.
 */
@Serializable
data class Allowance(
    val reason: String,
    @SerialName("max_amount") val maxAmount: Long,
    val currency: String,
    @SerialName("checkout_session_id") val checkoutSessionId: String,
    @SerialName("merchant_id") val merchantId: String,
    @SerialName("expires_at") val expiresAt: String,
)

/**
 * Server-side record for an issued `vt_` token. `used` is an AtomicBoolean so concurrent
 * redeem attempts on the same one-time token race safely -- only one can win.
 */
class TokenRecord(
    val allowance: Allowance,
    val created: String,
    val last4: String,
    val used: AtomicBoolean = AtomicBoolean(false),
)

/**
 * Body a merchant sends to redeem a token at checkout completion. Not part of the ACP spec --
 * an internal contract between our merchant and PSP mocks now that they run as separate
 * processes instead of sharing one in-process call.
 */
@Serializable
data class RedeemRequest(
    @SerialName("merchant_id") val merchantId: String,
    @SerialName("checkout_session_id") val checkoutSessionId: String,
    val amount: Long,
    val currency: String,
)

@Serializable
data class RedeemResult(val ok: Boolean, val reason: String)
