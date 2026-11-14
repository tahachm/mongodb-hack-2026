#!/usr/bin/env python3
"""
Download Amazon Reviews 2023 product metadata and convert it to the
Agentic Commerce Protocol (ACP) Product Feeds offline format.

Output per category:
  <output>/<category>/metadata.json
  <output>/<category>/products.jsonl
  <output>/<category>/source_metadata.jsonl

Important:
- The source metadata is a historical 2023 crawl, not live product data.
- The dataset groups records by parent_asin. It does not provide a complete,
  reliable set of purchasable child variants.
- A synthetic default variant ID is generated for feed testing. It is NOT
  an Amazon checkout-compatible item ID.
- Availability is omitted because the source does not provide reliable
  current inventory.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable

DATASET_BASE = (
    "https://mcauleylab.ucsd.edu/public_datasets/data/"
    "amazon_2023/raw/meta_categories"
)
SCHEMA_URL = (
    "https://raw.githubusercontent.com/agentic-commerce-protocol/"
    "agentic-commerce-protocol/main/spec/unreleased/json-schema/schema.feed.json"
)

CATEGORIES = [
    "All_Beauty",
    "Amazon_Fashion",
    "Appliances",
    "Arts_Crafts_and_Sewing",
    "Automotive",
    "Baby_Products",
    "Beauty_and_Personal_Care",
    "Books",
    "CDs_and_Vinyl",
    "Cell_Phones_and_Accessories",
    "Clothing_Shoes_and_Jewelry",
    "Digital_Music",
    "Electronics",
    "Gift_Cards",
    "Grocery_and_Gourmet_Food",
    "Handmade_Products",
    "Health_and_Household",
    "Health_and_Personal_Care",
    "Home_and_Kitchen",
    "Industrial_and_Scientific",
    "Kindle_Store",
    "Magazine_Subscriptions",
    "Movies_and_TV",
    "Musical_Instruments",
    "Office_Products",
    "Patio_Lawn_and_Garden",
    "Pet_Supplies",
    "Software",
    "Sports_and_Outdoors",
    "Subscription_Boxes",
    "Tools_and_Home_Improvement",
    "Toys_and_Games",
    "Video_Games",
    "Unknown",
]


def clean_text(value: Any) -> str:
    """Convert strings/lists of strings into clean plain text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        parts = [clean_text(item) for item in value]
        return "\n".join(part for part in parts if part)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value).strip()


def parse_details(value: Any) -> dict[str, Any]:
    """Amazon details are usually a dict, but some exports encode JSON text."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def parse_usd_minor_units(value: Any) -> int | None:
    """
    Convert an Amazon metadata price to USD cents.

    Accepts numeric values and unambiguous strings such as "$19.99".
    Rejects ranges and unparseable strings instead of guessing.
    """
    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, (int, float, Decimal)):
        raw = str(value)
    else:
        raw = str(value).strip()

    if not raw or raw.lower() in {"none", "null", "nan", "n/a", "unknown"}:
        return None

    # Only accept one unambiguous amount, optionally with USD/$ and separators.
    raw = raw.replace(",", "")
    match = re.fullmatch(
        r"\s*(?:USD\s*)?\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:USD)?\s*",
        raw,
        flags=re.IGNORECASE,
    )
    if not match:
        return None

    try:
        amount = Decimal(match.group(1))
        if amount < 0:
            return None
        cents = (amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        return int(cents)
    except (InvalidOperation, ValueError):
        return None


def flatten_categories(value: Any) -> list[str]:
    """Normalize Amazon category values into readable category paths."""
    if not isinstance(value, list):
        return []

    result: list[str] = []
    for item in value:
        if isinstance(item, str):
            text = item.strip()
            if text:
                result.append(text)
        elif isinstance(item, list):
            path = " > ".join(
                str(part).strip() for part in item if str(part).strip()
            )
            if path:
                result.append(path)
        elif isinstance(item, dict):
            # Avoid inventing semantics for unexpected category structures.
            text = clean_text(item.get("name") or item.get("title"))
            if text:
                result.append(text)

    # Preserve order while removing duplicates.
    return list(dict.fromkeys(result))


def build_description(record: dict[str, Any], details: dict[str, Any]) -> str:
    sections: list[str] = []

    description = clean_text(record.get("description"))
    features = clean_text(record.get("features"))

    if description:
        sections.append(description)
    if features:
        sections.append("Features:\n" + features)

    # Product specifications are useful to agents, but the ACP feed schema
    # does not currently expose a general-purpose product attributes object.
    if details:
        spec_lines = []
        for key, value in details.items():
            text = clean_text(value)
            if text:
                spec_lines.append(f"{key}: {text}")
        if spec_lines:
            sections.append("Specifications:\n" + "\n".join(spec_lines))

    return "\n\n".join(sections).strip()


def build_media(record: dict[str, Any], title: str, max_images: int) -> list[dict[str, Any]]:
    images = record.get("images")
    if not isinstance(images, list):
        return []

    media: list[dict[str, Any]] = []
    seen: set[str] = set()

    for image in images:
        if not isinstance(image, dict):
            continue

        url = (
            image.get("hi_res")
            or image.get("large")
            or image.get("thumb")
        )
        if not isinstance(url, str) or not url.startswith(("https://", "http://")):
            continue
        if url in seen:
            continue

        seen.add(url)
        media.append({
            "type": "image",
            "url": url,
            "alt_text": title[:500] if title else "Amazon product image",
        })
        if len(media) >= max_images:
            break

    return media


def build_barcodes(details: dict[str, Any]) -> list[dict[str, str]]:
    barcodes = []
    aliases = {
        "upc": "UPC",
        "ean": "EAN",
        "gtin": "GTIN",
        "isbn": "ISBN",
    }

    for key, value in details.items():
        normalized_key = str(key).strip().lower()
        barcode_type = aliases.get(normalized_key)
        if not barcode_type or value is None:
            continue

        barcode_value = re.sub(r"[\s-]", "", str(value))
        if barcode_value and barcode_value.lower() not in {"none", "null"}:
            barcodes.append({"type": barcode_type, "value": barcode_value})

    return barcodes


def convert_record(
    record: dict[str, Any],
    category: str,
    max_images: int,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str | None]:
    parent_asin = str(record.get("parent_asin") or "").strip()
    if not parent_asin:
        return None, None, "missing_parent_asin"

    title = clean_text(record.get("title")) or parent_asin
    details = parse_details(record.get("details"))
    description = build_description(record, details)

    product: dict[str, Any] = {
        "id": parent_asin,
        "title": title,
        "variants": [
            {
                # Synthetic identifier for catalog/feed testing only.
                # It is not a real Amazon child ASIN or checkout item ID.
                "id": f"{parent_asin}::dataset-default",
                "title": title,
            }
        ],
    }

    if description:
        product["description"] = {"plain": description}

    media = build_media(record, title, max_images)
    if media:
        product["media"] = media

    category_values = flatten_categories(record.get("categories"))
    main_category = clean_text(record.get("main_category"))
    if main_category and main_category not in category_values:
        category_values.insert(0, main_category)

    if category_values:
        product["variants"][0]["categories"] = [
            {"value": value, "taxonomy": "amazon"}
            for value in category_values
        ]

    price_minor = parse_usd_minor_units(record.get("price"))
    if price_minor is not None:
        product["variants"][0]["price"] = {
            "amount": price_minor,
            "currency": "USD",
        }

    barcodes = build_barcodes(details)
    if barcodes:
        product["variants"][0]["barcodes"] = barcodes

    # Deliberately do not set availability: the dataset has no reliable
    # current stock signal. Also do not map `store` to seller because it may
    # represent a brand/storefront rather than the merchant of record.

    source_metadata = {
        "product_id": parent_asin,
        "source": "Amazon Reviews 2023",
        "source_category": category,
        "store_field": record.get("store"),
        "average_rating": record.get("average_rating"),
        "rating_number": record.get("rating_number"),
        "details": details,
        "bought_together": record.get("bought_together"),
        "source_price": record.get("price"),
        "source_price_currency": "USD" if price_minor is not None else None,
    }

    return product, source_metadata, None


def load_schema(schema_path: Path | None) -> dict[str, Any]:
    if schema_path:
        with schema_path.open("r", encoding="utf-8") as f:
            return json.load(f)

    request = urllib.request.Request(
        SCHEMA_URL,
        headers={"User-Agent": "amazon-reviews-acp-converter/1.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def make_product_validator(schema_bundle: dict[str, Any]):
    try:
        import jsonschema
    except ImportError as exc:
        raise RuntimeError(
            "Missing dependency. Install it with: pip install -r requirements.txt"
        ) from exc

    # schema.feed.json is a bundle of $defs. Wrap Product as the root schema
    # while retaining the bundle's definitions for its nested $refs.
    product_schema = {
        "$schema": schema_bundle.get(
            "$schema", "https://json-schema.org/draft/2020-12/schema"
        ),
        "$defs": schema_bundle["$defs"],
        "$ref": "#/$defs/Product",
    }
    jsonschema.Draft202012Validator.check_schema(product_schema)
    return jsonschema.Draft202012Validator(
        product_schema,
        format_checker=jsonschema.FormatChecker(),
    )


def download_and_convert_category(
    category: str,
    output_root: Path,
    limit: int,
    max_images: int,
    validator: Any,
) -> dict[str, int]:
    url = f"{DATASET_BASE}/meta_{category}.jsonl.gz"
    out_dir = output_root / category
    out_dir.mkdir(parents=True, exist_ok=True)

    metadata = {
        "id": f"amazon-reviews-2023-{category.lower()}",
    }
    with (out_dir / "metadata.json").open("w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
        f.write("\n")

    products_path = out_dir / "products.jsonl"
    sidecar_path = out_dir / "source_metadata.jsonl"

    counts = {
        "read": 0,
        "written": 0,
        "with_price": 0,
        "without_price": 0,
        "invalid_json": 0,
        "invalid_schema": 0,
        "missing_parent_asin": 0,
    }
    schema_errors_shown = 0

    request = urllib.request.Request(
        url,
        headers={"User-Agent": "amazon-reviews-acp-converter/1.0"},
    )

    print(f"\n[{category}] Downloading/streaming metadata:")
    print(f"  {url}")

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            with gzip.GzipFile(fileobj=response, mode="rb") as gz:
                with (
                    products_path.open("w", encoding="utf-8") as products_file,
                    sidecar_path.open("w", encoding="utf-8") as sidecar_file,
                ):
                    for raw_line in gz:
                        if limit and counts["read"] >= limit:
                            break

                        if not raw_line.strip():
                            continue

                        try:
                            record = json.loads(raw_line)
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            counts["invalid_json"] += 1
                            continue

                        counts["read"] += 1
                        product, sidecar, error = convert_record(
                            record, category, max_images
                        )

                        if error == "missing_parent_asin":
                            counts["missing_parent_asin"] += 1
                            continue
                        if product is None or sidecar is None:
                            continue

                        errors = list(validator.iter_errors(product))
                        if errors:
                            counts["invalid_schema"] += 1
                            if schema_errors_shown < 5:
                                print(
                                    "  Schema validation error:",
                                    errors[0].message,
                                    file=sys.stderr,
                                )
                                schema_errors_shown += 1
                            continue

                        products_file.write(
                            json.dumps(product, ensure_ascii=False, separators=(",", ":"))
                            + "\n"
                        )
                        sidecar_file.write(
                            json.dumps(sidecar, ensure_ascii=False, separators=(",", ":"))
                            + "\n"
                        )
                        counts["written"] += 1

                        if "price" in product["variants"][0]:
                            counts["with_price"] += 1
                        else:
                            counts["without_price"] += 1

                        if counts["read"] % 100_000 == 0:
                            print(
                                f"  Processed {counts['read']:,}; "
                                f"written {counts['written']:,}"
                            )

    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"Download failed for {category}: HTTP {exc.code} ({url})"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Could not download {category}: {exc.reason}"
        ) from exc
    except OSError as exc:
        raise RuntimeError(
            f"Could not read the compressed metadata for {category}: {exc}"
        ) from exc

    print(
        f"  Finished: read={counts['read']:,}, "
        f"written={counts['written']:,}, "
        f"with_price={counts['with_price']:,}, "
        f"without_price={counts['without_price']:,}, "
        f"invalid_schema={counts['invalid_schema']:,}"
    )

    with (out_dir / "conversion_report.json").open("w", encoding="utf-8") as f:
        json.dump(
            {
                "category": category,
                "source_url": url,
                "limit": limit,
                "counts": counts,
                "notes": [
                    "Prices are historical USD observations from the dataset crawl.",
                    "Availability is omitted because current inventory is unknown.",
                    "Variant IDs are synthetic and are not Amazon checkout IDs.",
                ],
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
        f.write("\n")

    return counts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download Amazon Reviews 2023 metadata and write ACP Product Feeds."
    )
    parser.add_argument(
        "--category",
        default="All_Beauty",
        help=(
            "Dataset category, or 'all'. Default: All_Beauty. "
            f"Available: {', '.join(CATEGORIES)}"
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data/amazon_reviews_2023_acp"),
        help="Output directory. Default: data/amazon_reviews_2023_acp",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=1000,
        help="Maximum metadata records per category. Use 0 for all records. Default: 1000.",
    )
    parser.add_argument(
        "--max-images",
        type=int,
        default=8,
        help="Maximum product images to include per product. Default: 8.",
    )
    parser.add_argument(
        "--schema-path",
        type=Path,
        default=None,
        help="Optional local path to the ACP schema.feed.json. Otherwise fetches repository main.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.limit < 0:
        print("--limit must be >= 0", file=sys.stderr)
        return 2
    if args.max_images < 0:
        print("--max-images must be >= 0", file=sys.stderr)
        return 2

    if args.category.lower() == "all":
        categories = CATEGORIES
    else:
        category_lookup = {name.lower(): name for name in CATEGORIES}
        category = category_lookup.get(args.category.lower())
        if not category:
            print(
                f"Unknown category: {args.category}\n"
                f"Available categories: {', '.join(CATEGORIES)}",
                file=sys.stderr,
            )
            return 2
        categories = [category]

    print("Loading ACP Product Feed JSON Schema...")
    try:
        schema_bundle = load_schema(args.schema_path)
        validator = make_product_validator(schema_bundle)
    except Exception as exc:
        print(f"Could not load/initialize ACP schema: {exc}", file=sys.stderr)
        return 1

    args.output_dir.mkdir(parents=True, exist_ok=True)

    totals = {
        "read": 0,
        "written": 0,
        "with_price": 0,
        "without_price": 0,
        "invalid_json": 0,
        "invalid_schema": 0,
        "missing_parent_asin": 0,
    }

    try:
        for category in categories:
            counts = download_and_convert_category(
                category=category,
                output_root=args.output_dir,
                limit=args.limit,
                max_images=args.max_images,
                validator=validator,
            )
            for key, value in counts.items():
                totals[key] += value
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        return 1

    print("\nAll done.")
    print(f"Output directory: {args.output_dir.resolve()}")
    print(f"Categories processed: {len(categories)}")
    print(f"Total products written: {totals['written']:,}")
    print(f"Products with price: {totals['with_price']:,}")
    print(f"Products without price: {totals['without_price']:,}")
    print(f"Schema-invalid products skipped: {totals['invalid_schema']:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
