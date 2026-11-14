package com.mongodbhack.psp

/** This process is the only PSP; nothing to select at startup beyond the port. */
object Config {
    val port: Int = System.getenv("PORT")?.toIntOrNull() ?: 8081
}
