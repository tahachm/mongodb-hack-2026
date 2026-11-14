# mongodb-hack-2026

Agents in Context Toronto (MongoDB hackathon, Nov 14 2026).

Mock Agentic Commerce Protocol (ACP, spec 2026-04-17) backend: merchants and a payment
service provider (PSP), each a standalone Kotlin/Ktor service.

## Layout

- `merchant/` — ACP merchant mock. One process == one merchant (`MERCHANT_ID` env var
  selects which of the five parody merchants in `merchants.json` it serves; `PORT` picks
  the port). All merchant processes read the same generated `catalog.json` and filter by
  the `merchantIds` tag on each item, so running N instances keeps them in sync with one
  source of truth. `merchant/tools/generate_catalog.py` (uv script) regenerates
  `src/main/resources/{catalog,merchants}.json` deterministically.
- `psp/` — ACP payment service provider mock (`delegate_payment` / `vt_` tokens).
- `amazon_data/` — standalone tool that turns the Amazon Reviews 2023 dataset into ACP
  Product Feed offline files; unrelated to the merchant/PSP services above.

Both `merchant/` and `psp/` are independent Gradle projects (Kotlin, Ktor 3, JVM 21).

## Running

```bash
cd merchant && MERCHANT_ID=mall-wart PORT=8081 ./gradlew run
cd psp && ./gradlew run
```

Both are early scaffolding: process/catalog loading is wired up, ACP routes
(`/checkout_sessions`, `/delegate_payment`, idempotency semantics, etc.) are in progress.
