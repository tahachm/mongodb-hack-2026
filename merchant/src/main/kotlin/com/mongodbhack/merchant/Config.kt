package com.mongodbhack.merchant

/**
 * One process == one merchant. Run this jar N times with different MERCHANT_ID/PORT to bring
 * up N merchants simultaneously, all reading the same catalog.json and filtering by identity.
 */
object Config {
    val merchantId: String = System.getenv("MERCHANT_ID")
        ?: error("MERCHANT_ID env var is required, e.g. mall-wart, somefrills, wellgreens, circuitspree, threadbarn")

    val port: Int = System.getenv("PORT")?.toIntOrNull() ?: 8080
}
