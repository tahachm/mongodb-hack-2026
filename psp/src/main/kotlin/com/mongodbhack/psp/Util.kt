package com.mongodbhack.psp

import java.security.SecureRandom
import java.time.Instant

private val secureRandom = SecureRandom()

/** Lowercase hex string from `bytes` random bytes, e.g. for `vt_<hex>` token ids. */
fun randomHex(bytes: Int): String {
    val b = ByteArray(bytes)
    secureRandom.nextBytes(b)
    return b.joinToString("") { "%02x".format(it) }
}

fun nowIso(): String = Instant.now().toString()
