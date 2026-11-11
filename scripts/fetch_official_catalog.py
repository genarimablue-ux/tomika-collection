#!/usr/bin/env python3
"""Extract Tomica regular lineup product numbers, names and image URLs.

Source: https://www.takaratomy.co.jp/products/tomica/lineup/regular/
Usage: python3 scripts/fetch_official_catalog.py
Output: data/tomica-catalog.json
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

SOURCE_URL = "https://www.takaratomy.co.jp/products/tomica/lineup/regular/"
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "data" / "tomica-catalog.json"
USER_AGENT = "TomicaCollection/1.0 (official lineup catalog extraction)"
PRODUCT_ALT = re.compile(r"^\s*No\.\s*(\d+)\s*(.*?)\s*$", re.IGNORECASE)
RANGE_LINK = re.compile(r"\d{3}-\d{3}\.htm$", re.IGNORECASE)


def fetch_html(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"Official site returned HTTP {response.status}: {url}")
        return response.read().decode("utf-8", "replace")


class RangeLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.current_href: str | None = None
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = dict(attrs)
        if tag == "a":
            self.current_href = attrs_map.get("href")
        elif tag == "img" and self.current_href:
            src = attrs_map.get("src", "") or ""
            if "tomica_no-" in src and RANGE_LINK.search(self.current_href):
                self.links.append(self.current_href)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a":
            self.current_href = None


class ProductImageParser(HTMLParser):
    def __init__(self, page_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.page_url = page_url
        self.products: list[dict[str, object]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "img":
            return
        attrs_map = dict(attrs)
        alt = (attrs_map.get("alt") or "").strip()
        src = (attrs_map.get("src") or "").strip()
        match = PRODUCT_ALT.match(alt)
        if not match or not src:
            return
        number = int(match.group(1))
        name = match.group(2).strip()
        if not name:
            return
        self.products.append(
            {
                "number": number,
                "name": name,
                "imageUrl": urljoin(self.page_url, src),
            }
        )


def main() -> None:
    index_html = fetch_html(SOURCE_URL)
    link_parser = RangeLinkParser()
    link_parser.feed(index_html)
    page_urls = [SOURCE_URL]
    for href in link_parser.links:
        absolute_url = urljoin(SOURCE_URL, href)
        if absolute_url not in page_urls:
            page_urls.append(absolute_url)

    products: list[dict[str, object]] = []
    for index, page_url in enumerate(page_urls):
        page_html = index_html if index == 0 else fetch_html(page_url)
        parser = ProductImageParser(page_url)
        parser.feed(page_html)
        products.extend(parser.products)
        print(f"Read {len(parser.products):>2} product images from {page_url}")
        if index < len(page_urls) - 1:
            time.sleep(0.4)

    products.sort(key=lambda item: int(item["number"]))
    unique_products: dict[int, dict[str, object]] = {}
    for product in products:
        number = int(product["number"])
        if number in unique_products:
            # Some products have several gallery images with the same alt text.
            if unique_products[number]["name"] != product["name"]:
                raise RuntimeError(f"Conflicting names for product number {number}; review the page markup")
            continue
        unique_products[number] = product

    ordered_products = list(unique_products.values())
    numbers = [int(product["number"]) for product in ordered_products]
    expected_numbers = list(range(1, numbers[-1] + 1)) if numbers else []
    if len(ordered_products) < 4 or numbers != expected_numbers:
        missing = sorted(set(expected_numbers) - set(numbers))
        raise RuntimeError(f"Incomplete product sequence; missing numbers: {missing[:20]}. Catalog was not overwritten.")

    payload = {
        "sourceUrl": SOURCE_URL,
        "retrievedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": len(ordered_products),
        "products": ordered_products,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {len(ordered_products)} products to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
