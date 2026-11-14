# mongodb-hack-2026

Agents in Context Toronto (MongoDB hackathon, Nov 14 2026).

Mock Agentic Commerce Protocol (ACP, spec 2026-04-17) backend -- merchants, a payment
service provider (PSP), and a vector-search preferences store -- each a standalone
Kotlin/Ktor service.

## Layout

- `merchant/` — ACP merchant mock. One process == one merchant (`MERCHANT_ID` env var
  selects which of the five parody merchants in `merchants.json` it serves; `PORT` picks
  the port, default 8080). All merchant processes read the same generated `catalog.json`
  and filter by the `merchantIds` tag on each item, so running N instances keeps them in
  sync with one source of truth. The bundled `catalog.json` is 10,000 real Amazon Reviews
  2023 products (5k fashion from `Clothing_Shoes_and_Jewelry`, 5k beauty from
  `Beauty_and_Personal_Care`, priced records only), built by `merchant/tools/amazon_catalog.py`
  (uv script, streams the dataset). Fashion is carried by threadbarn, beauty by wellgreens,
  mall-wart carries a share of both; somefrills and circuitspree carry nothing.
  `merchant/tools/generate_catalog.py` still regenerates the old synthetic catalog
  deterministically (and `merchants.json`). With `MONGODB_URI` set, merchants read the
  catalog from Atlas instead and `/products` uses Atlas Vector Search (see below).
- `psp/` — ACP payment service provider mock (`delegate_payment` / `vt_` tokens), default
  port 8081.
- `preferences/` — past-purchase vector store, backed by MongoDB Atlas Vector Search.
  Not part of the ACP spec -- the shopping agent calls it directly to remember and recall
  what a buyer has bought before. Default port 8083.
- `amazon_data/` — standalone tool that turns the Amazon Reviews 2023 dataset into ACP
  Product Feed offline files; unrelated to the merchant/PSP services above.

`merchant/`, `psp/` and `preferences/` are independent Gradle projects (Kotlin, Ktor 3, JVM 21).

## Running

```bash
cd psp && ./gradlew run                                    # :8081
cd merchant && MERCHANT_ID=mall-wart PORT=8090 ./gradlew run   # :8090, redeems tokens via PSP on :8081
cd preferences && MONGODB_URI="mongodb+srv://..." ./gradlew run   # :8083
```

`merchant`'s `PSP_URL` env var points it at the PSP (default `http://127.0.0.1:8081`).

**Merchant catalog in Atlas.** Set `MONGODB_URI` (and optionally `MONGODB_DB`) on the
merchants and they load their items from the `products` collection at startup and answer
`/products?q=` with `$vectorSearch` (semantic: "something for a beach wedding" works, not just
keyword overlap). Fill that collection once -- and again whenever `catalog.json` changes --
with:

```bash
MONGODB_URI="mongodb+srv://..." uv run merchant/tools/load_catalog_to_atlas.py --wait
```

It replaces the collection with all 10,000 items with an `embedding_text` field and creates the
`product_vector_index` index, which uses Atlas Automated Embedding (Voyage AI, `EMBEDDING_MODEL`,
default `voyage-4`) -- Atlas embeds every product server-side, so neither the script nor the
merchant calls an embedding API. `--wait` polls until the index is queryable. If vector search
is unavailable at query time, a merchant falls back to keyword search over its loaded items.
Without `MONGODB_URI`, merchants use the bundled `catalog.json` and keyword search (tests do).

`preferences` requires `MONGODB_URI` (an Atlas connection string -- Atlas Vector Search
isn't available against a local `mongod`). `MONGODB_DB` (default `agentic_commerce`) and
`EMBEDDING_MODEL` (default `voyage-4`) are optional. Vectors are never computed by this
service or the agent -- the index is `autoEmbed`, so MongoDB Atlas Vector Search sends the
raw text straight to a Voyage AI model and manages the resulting embedding entirely
server-side. On startup this service creates the `purchase_vectors` collection and its
`purchase_vector_index` index if they don't exist yet; that build is asynchronous, so
`/purchases/search` can return no matches for the first minute or so after a fresh start.

## Endpoints

All three services require an `Idempotency-Key` header on every POST: the same key + the
same body replays the cached response (`Idempotent-Replayed: true`); the same key + a
different body is a `422 idempotency_conflict`. Errors are `{type, code, message, param?}`.

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

**preferences**
- `GET /health`
- `POST /purchases` — record a purchase: one or more raw-text notes (MongoDB Atlas Vector
  Search's Automated Embedding generates the vectors server-side via Voyage AI -- this
  service never computes or sees one), the product listing bought, and freeform
  conversation notes. Each note is stored alongside the same listing/notes under a shared
  purchase id.
- `POST /purchases/search` — bulk semantic lookup: several raw-text queries in one request,
  each run as its own `$vectorSearch` scoped to one `buyer_id` (and optionally one
  `merchant_id`), returning ranked past purchases per query.

## Tests

```bash
cd psp && ./gradlew test
cd merchant && ./gradlew test
cd preferences && ./gradlew test
```

All three are Ktor `testApplication` integration tests (real routing, in-memory server); the
merchant's PSP-dependent tests spin up a real throwaway Ktor server as a fake PSP rather
than mocking the HTTP call away.

`preferences`'s tests cover request validation and Idempotency-Key handling only -- every
case returns before Mongo is touched, so the suite needs no live database. Recording a
purchase and running a real `$vectorSearch` are exercised manually against Atlas instead:
index builds are asynchronous, so a round trip through a freshly created index would be
flaky by construction, not a real bug in the service.
