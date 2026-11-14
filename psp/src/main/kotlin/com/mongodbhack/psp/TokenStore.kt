package com.mongodbhack.psp

import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * All `vt_` tokens issued by this PSP process. In-memory only -- a restart forgets every
 * outstanding allowance, which is fine for a mock.
 */
object TokenStore {
    private val tokens = ConcurrentHashMap<String, TokenRecord>()

    fun put(id: String, record: TokenRecord) {
        tokens[id] = record
    }

    /**
     * Validates and, on success, atomically marks the token used. Mirrors the checks a real
     * PSP runs before moving money: token exists, not already spent, bound to this
     * merchant/session/currency, within the allowance ceiling, not expired.
     */
    fun redeem(tokenId: String?, merchantId: String, checkoutSessionId: String, amount: Long, currency: String): RedeemResult {
        val t = tokens[tokenId ?: ""] ?: return RedeemResult(false, "unknown payment token")
        val al = t.allowance
        if (t.used.get()) return RedeemResult(false, "token already used (one_time allowance)")
        if (al.merchantId != merchantId) return RedeemResult(false, "token not valid for merchant $merchantId")
        if (al.checkoutSessionId != checkoutSessionId) return RedeemResult(false, "token bound to a different checkout session")
        if (al.currency != currency) return RedeemResult(false, "currency mismatch")
        if (amount > al.maxAmount) return RedeemResult(false, "amount $amount exceeds allowance max_amount ${al.maxAmount}")
        if (Instant.parse(al.expiresAt).isBefore(Instant.now())) return RedeemResult(false, "allowance expired")
        if (!t.used.compareAndSet(false, true)) return RedeemResult(false, "token already used (one_time allowance)")
        return RedeemResult(true, "ok")
    }
}
