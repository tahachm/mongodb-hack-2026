# mongodb-hack-2026

Agents in Context Toronto (MongoDB hackathon, Nov 14 2026).

Mock Agentic Commerce Protocol (ACP, spec 2026-04-17) backend: merchants and a payment
service provider (PSP), each a standalone Kotlin/Ktor service.

## Layout

- `merchant/` — ACP merchant mock. One process == one merchant (`MERCHANT_ID` env var
  selects which of the five parody merchants in `merchants.json` it serves; `PORT` picks
  the port, default 8080). All merchant processes read the same generated `catalog.json`
  and filter by the `merchantIds` tag on each item, so running N instances keeps them in
  sync with one source of truth. `merchant/tools/generate_catalog.py` (uv script)
  regenerates `src/main/resources/{catalog,merchants}.json` deterministically.
- `psp/` — ACP payment service provider mock (`delegate_payment` / `vt_` tokens), default
  port 8081.
- `amazon_data/` — standalone tool that turns the Amazon Reviews 2023 dataset into ACP
  Product Feed offline files; unrelated to the merchant/PSP services above.

Both `merchant/` and `psp/` are independent Gradle projects (Kotlin, Ktor 3, JVM 21).

## Running

```bash
cd psp && ./gradlew run                                    # :8081
cd merchant && MERCHANT_ID=mall-wart PORT=8090 ./gradlew run   # :8090, redeems tokens via PSP on :8081
```

`merchant`'s `PSP_URL` env var points it at the PSP (default `http://127.0.0.1:8081`).

## Endpoints

Both services require an `Idempotency-Key` header on every POST: the same key + the same
body replays the cached response (`Idempotent-Replayed: true`); the same key + a different
body is a `422 idempotency_conflict`. Errors are `{type, code, message, param?}`.

**merchant**
- `GET /health`, `GET /products?q=`
- `POST /checkout_sessions` — price items, create a session (`ready_for_payment`)
- `GET /checkout_sessions/{id}`
- `POST /checkout_sessions/{id}` — re-price; `405` once the session is closed
- `POST /checkout_sessions/{id}/complete` — redeems the session's total against the PSP
  (`402 payment_declined` and the session stays open if the PSP says no; `503` if the PSP
  is unreachable)
- `POST /checkout_sessions/{id}/cancel`

**psp**
- `GET /health`
- `POST /agentic_commerce/delegate_payment` — issues a `vt_` token scoped to one
  merchant/session/currency/ceiling/expiry (an `Allowance`)
- `POST /tokens/{id}/redeem` — one-time redemption, called by a merchant at checkout
  completion. Not part of the ACP spec: an internal contract between the two mocks now
  that they're separate processes instead of one in-process call.

## Tests

```bash
cd psp && ./gradlew test
cd merchant && ./gradlew test
```

Both are Ktor `testApplication` integration tests (real routing, in-memory server); the
merchant's PSP-dependent tests spin up a real throwaway Ktor server as a fake PSP rather
than mocking the HTTP call away.
