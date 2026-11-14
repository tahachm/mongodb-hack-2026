# /// script
# requires-python = ">=3.12"
# dependencies = ["pymongo>=4.10", "certifi"]
# ///
"""Loads the merchant catalog (src/main/resources/catalog.json) into MongoDB Atlas, where the
merchant service searches it with Atlas Vector Search instead of keyword matching.

Each item becomes one document in the `products` collection (`_id` = item id), with the same
fields as catalog.json plus `embedding_text`: the name, brand, category and attributes as one
sentence. The `product_vector_index` vector index uses Atlas Automated Embedding (`autoEmbed`)
on that field, so Atlas has Voyage AI embed every product server-side -- no embedding API is
called from here or from the merchant -- and filters on `merchantIds` so each merchant process
only searches the items it carries.

Re-running replaces the collection's contents (the index is kept and re-embeds the new docs).
Atlas builds embeddings asynchronously; --wait polls until the index is queryable.

Usage: MONGODB_URI=mongodb+srv://... uv run load_catalog_to_atlas.py [--wait]
Env:   MONGODB_URI (required), MONGODB_DB (default agentic_commerce),
       EMBEDDING_MODEL (default voyage-4, same as the preferences service)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import certifi
from pymongo import MongoClient
from pymongo.operations import SearchIndexModel

CATALOG = Path(__file__).resolve().parent.parent / "src/main/resources/catalog.json"
COLLECTION = "products"
INDEX_NAME = "product_vector_index"
BATCH = 1000


def embedding_text(item: dict) -> str:
    """What a product means, in words: everything a buyer might describe it by."""
    sub = item.get("subcategory", "").replace("-", " ")
    parts = [item["name"], f"Brand: {item['brand']}", f"Category: {item['category']}, {sub}"]
    attrs = item.get("attributes") or {}
    if attrs:
        parts.append("; ".join(f"{k.replace('_', ' ')}: {v}" for k, v in attrs.items()))
    return ". ".join(parts)


def index_definition(model: str) -> dict:
    return {
        "fields": [
            {"type": "autoEmbed", "path": "embedding_text", "model": model, "modality": "text"},
            {"type": "filter", "path": "merchantIds"},
        ]
    }


def wait_until_queryable(coll, timeout_s: int) -> None:
    started = time.monotonic()
    last = None
    while time.monotonic() - started < timeout_s:
        info = next(iter(coll.list_search_indexes(INDEX_NAME)), None)
        status = (info or {}).get("status")
        queryable = (info or {}).get("queryable")
        if (status, queryable) != last:
            print(f"  [{time.monotonic() - started:5.0f}s] index status={status} queryable={queryable}", flush=True)
            last = (status, queryable)
        if queryable and status == "READY":
            print(f"index ready after {time.monotonic() - started:.0f}s")
            return
        time.sleep(10)
    sys.exit(f"index not ready after {timeout_s}s -- check it in the Atlas UI")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--wait", action="store_true", help="poll until the vector index is queryable")
    parser.add_argument("--timeout", type=int, default=1800, help="--wait timeout in seconds")
    args = parser.parse_args()

    uri = os.environ.get("MONGODB_URI") or sys.exit("MONGODB_URI is required")
    db_name = os.environ.get("MONGODB_DB", "agentic_commerce")
    model = os.environ.get("EMBEDDING_MODEL", "voyage-4")

    items = json.loads(CATALOG.read_text(encoding="utf-8"))
    docs = [{"_id": it["id"], **it, "embedding_text": embedding_text(it)} for it in items]

    # certifi: python.org/pyenv builds on macOS often lack system CA certs for Atlas TLS.
    # Generous selection timeout: high-latency links can need well over the 30s default.
    client = MongoClient(uri, tlsCAFile=certifi.where(), serverSelectionTimeoutMS=60000)
    coll = client[db_name][COLLECTION]
    started = time.monotonic()
    deleted = coll.delete_many({}).deleted_count
    for i in range(0, len(docs), BATCH):
        coll.insert_many(docs[i : i + BATCH], ordered=False)
    print(f"replaced {deleted} docs with {len(docs)} in {db_name}.{COLLECTION} ({time.monotonic() - started:.1f}s)")

    existing = {ix["name"] for ix in coll.list_search_indexes()}
    if INDEX_NAME in existing:
        print(f"index {INDEX_NAME} exists; Atlas re-embeds the new documents")
    else:
        coll.create_search_index(SearchIndexModel(index_definition(model), name=INDEX_NAME, type="vectorSearch"))
        print(f"created index {INDEX_NAME} (autoEmbed, model {model})")

    if args.wait:
        wait_until_queryable(coll, args.timeout)


if __name__ == "__main__":
    main()
