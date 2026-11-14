package com.mongodbhack.merchant

import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty

fun main() {
    val merchant = Catalog.merchants.find { it.id == Config.merchantId }
        ?: error(
            "Unknown MERCHANT_ID '${Config.merchantId}'. Known merchants: " +
                Catalog.merchants.joinToString { it.id }
        )
    val items = Catalog.itemsFor(Config.merchantId)
    val byCategory = items.groupingBy { it.category }.eachCount().toSortedMap()
    println(
        "[${merchant.name}] (${Config.merchantId}) loaded ${items.size} / ${Catalog.allItems.size} " +
            "catalog items on port ${Config.port} -- categories: $byCategory"
    )

    embeddedServer(Netty, port = Config.port, host = "0.0.0.0") {}
        .start(wait = true)
}
