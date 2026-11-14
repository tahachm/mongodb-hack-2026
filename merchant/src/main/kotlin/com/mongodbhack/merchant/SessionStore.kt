package com.mongodbhack.merchant

import java.util.concurrent.ConcurrentHashMap

/** All checkout sessions for this merchant process. In-memory only -- a restart forgets every
 * open session, which is fine for a mock. */
object SessionStore {
    private val sessions = ConcurrentHashMap<String, CheckoutSession>()

    fun get(id: String): CheckoutSession? = sessions[id]

    fun put(session: CheckoutSession) {
        sessions[session.id] = session
    }
}
