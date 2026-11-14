# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Builds the merchant catalog from real Amazon Reviews 2023 product metadata instead of the
synthetic generator (generate_catalog.py), keeping the exact same catalog.json item shape so
the merchant service needs no code changes.

Scope: fashion (Clothing_Shoes_and_Jewelry) + beauty (Beauty_and_Personal_Care), 5,000 priced
products each. Clothing_Shoes_and_Jewelry is used for fashion rather than Amazon_Fashion: only
~12% of Amazon_Fashion records carry a price and its category path is always just
"AMAZON FASHION", vs ~55% priced with a real Women > Shoes > Sandals hierarchy.

Records without a single unambiguous USD price are dropped -- checkout needs one on every
item. Merchant assignment reuses generate_catalog.py's approach (independent seeded roll per
eligible merchant, fallback to the most likely one), so fashion lands at Thread Barn and
beauty at WellGreens, with Mall-Wart carrying a share of both. SomeFrills and CircuitSpree
carry nothing in this catalog.

Deterministic: records are taken in file order and every random draw is seeded from SHA-256 of
(seed, asin), so re-running reproduces byte-identical output as long as the source files don't
change.

Usage: uv run amazon_catalog.py                      # streams from the dataset host
       uv run amazon_catalog.py --source-dir DIR     # reads DIR/meta_<Category>.jsonl.gz
Writes: ../src/main/resources/catalog.json  (merchants.json is left as-is)
"""

import argparse
import gzip
import hashlib
import json
import random
import re
import urllib.request
from collections import Counter
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterator

DATASET_BASE = "https://mcauleylab.ucsd.edu/public_datasets/data/amazon_2023/raw/meta_categories"
RNG_SEED = "amazon-catalog-v1"
PER_CATEGORY = 5000
MAX_NAME_LEN = 150
MAX_ATTR_LEN = 80
MIN_PRICE_CENTS = 100

# dataset file -> our category id + which merchants may carry it (probability per merchant).
SOURCES = {
    "Clothing_Shoes_and_Jewelry": {
        "category": "fashion",
        "merchant_probs": {"threadbarn": 0.9, "mall-wart": 0.4},
    },
    "Beauty_and_Personal_Care": {
        "category": "beauty",
        "merchant_probs": {"wellgreens": 0.9, "mall-wart": 0.4},
    },
}

# Amazon `details` keys worth surfacing as catalog attributes (searchable by the merchant's
# /products?q=). Everything else (UPCs, model numbers, package dimensions, dates) is noise.
ATTRIBUTE_KEYS = {
    "Color": "color",
    "Size": "size",
    "Material": "material",
    "Style": "style",
    "Pattern": "pattern",
    "Department": "department",
    "Closure Type": "closure",
    "Metal Type": "metal",
    "Item Form": "form",
    "Scent": "scent",
    "Skin Type": "skin_type",
    "Hair Type": "hair_type",
    "Finish Type": "finish",
    "Product Benefits": "benefits",
    "Sun Protection": "spf",
    "Unit Count": "unit_count",
    "Age Range (Description)": "age_range",
}

# Leading category-path segments that are the same for every record in a file.
CATEGORY_PREFIXES = {"AMAZON FASHION", "Clothing, Shoes & Jewelry", "All Beauty", "Beauty & Personal Care"}

OUT = Path(__file__).resolve().parent.parent / "src/main/resources/catalog.json"


def seeded_rng(*parts) -> random.Random:
    key = "|".join(str(p) for p in parts).encode()
    return random.Random(int.from_bytes(hashlib.sha256(key).digest()[:8], "big"))


def assign_merchants(rng: random.Random, probs: dict[str, float]) -> list[str]:
    chosen = [m for m, p in probs.items() if rng.random() < p]
    return sorted(chosen) if chosen else [max(probs, key=probs.get)]


def clean(value: Any) -> str:
    if isinstance(value, list):
        value = " ".join(str(v) for v in value)
    return re.sub(r"\s+", " ", str(value)).strip() if value is not None else ""


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;-|/")


def parse_price_cents(value: Any) -> int | None:
    """Same rules as amazon_data/amazon_reviews_to_acp.py: one unambiguous USD amount, or None."""
    if value is None or isinstance(value, bool):
        return None
    raw = str(value).strip().replace(",", "")
    match = re.fullmatch(r"\s*(?:USD\s*)?\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:USD)?\s*", raw, re.IGNORECASE)
    if not match:
        return None
    try:
        cents = int((Decimal(match.group(1)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except InvalidOperation:
        return None
    # The dataset has placeholder prices like $0.01; treat anything under $1 as no price.
    return cents if cents >= MIN_PRICE_CENTS else None


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower().replace("&", "and")).strip("-")


def subcategory(categories: list[str]) -> str:
    path = [c for c in categories if c not in CATEGORY_PREFIXES]
    return slug(" ".join(path[:2])) or "general"


def details_of(record: dict) -> dict:
    details = record.get("details")
    if isinstance(details, str):
        try:
            details = json.loads(details)
        except json.JSONDecodeError:
            details = {}
    return details if isinstance(details, dict) else {}


def read_records(dataset: str, source_dir: Path | None) -> Iterator[dict]:
    if source_dir:
        stream = gzip.open(source_dir / f"meta_{dataset}.jsonl.gz", "rb")
    else:
        url = f"{DATASET_BASE}/meta_{dataset}.jsonl.gz"
        stream = gzip.GzipFile(fileobj=urllib.request.urlopen(url, timeout=120))
    with stream:
        for line in stream:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def convert(record: dict, category: str, probs: dict[str, float]) -> dict | None:
    asin = clean(record.get("parent_asin"))
    title = clean(record.get("title"))
    price = parse_price_cents(record.get("price"))
    if not asin or not title or price is None:
        return None

    details = details_of(record)
    brand = clean(details.get("Brand") or details.get("Brand Name") or record.get("store")) or "Unbranded"
    attributes = {}
    for key, out_key in ATTRIBUTE_KEYS.items():
        value = clip(clean(details.get(key)), MAX_ATTR_LEN)
        if value:
            attributes[out_key] = value

    return {
        "id": asin,
        "name": clip(title, MAX_NAME_LEN),
        "brand": clip(brand, MAX_ATTR_LEN),
        "category": category,
        "subcategory": subcategory([clean(c) for c in record.get("categories") or []]),
        "priceCents": price,
        "currency": "USD",
        "attributes": attributes,
        "merchantIds": assign_merchants(seeded_rng(RNG_SEED, asin), probs),
    }


def build(source_dir: Path | None, per_category: int) -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()
    for dataset, spec in SOURCES.items():
        read = kept = 0
        for record in read_records(dataset, source_dir):
            read += 1
            item = convert(record, spec["category"], spec["merchant_probs"])
            if item is None or item["id"] in seen:
                continue
            seen.add(item["id"])
            items.append(item)
            kept += 1
            if kept >= per_category:
                break
        print(f"{dataset}: read {read:,}, kept {kept:,} priced items ({100 * kept / max(read, 1):.0f}%)")
    return items


def print_stats(items: list[dict]) -> None:
    by_merchant = Counter(m for it in items for m in it["merchantIds"])
    print(f"total items: {len(items):,}")
    for m, n in sorted(by_merchant.items()):
        print(f"  {m}: {n:,}")
    attrs = Counter(k for it in items for k in it["attributes"])
    print("attribute coverage:", ", ".join(f"{k} {100 * n / len(items):.0f}%" for k, n in attrs.most_common(8)))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source-dir", type=Path, help="local dir with meta_<Category>.jsonl.gz files")
    parser.add_argument("--per-category", type=int, default=PER_CATEGORY)
    args = parser.parse_args()

    items = build(args.source_dir, args.per_category)
    # Compact, single line -- same format generate_catalog.py writes.
    OUT.write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print_stats(items)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
