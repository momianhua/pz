#!/usr/bin/env python3
"""Fetch recent news metadata from public RSS feeds without an API key."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from urllib.parse import quote_plus
from xml.etree import ElementTree

import requests


def read_feed(url: str, limit: int) -> list[dict[str, str]]:
    response = requests.get(url, headers={"User-Agent": "Mozilla/5.0 AgentGatewayResearch/1.0"}, timeout=20)
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    results = []
    for item in root.findall(".//item")[:limit]:
        value = lambda name: (item.findtext(name) or "").strip()
        result = {
            "title": value("title"),
            "url": value("link"),
            "publishedAt": value("pubDate"),
            "source": value("source"),
        }
        if result["title"] and result["url"]:
            results.append(result)
    return results


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("query", nargs="+")
    parser.add_argument("--limit", type=int, default=12)
    args = parser.parse_args()
    query = " ".join(args.query).strip()
    limit = max(1, min(50, args.limit))
    encoded = quote_plus(query)
    feeds = [
        f"https://news.google.com/rss/search?q={encoded}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
        f"https://www.bing.com/news/search?q={encoded}&format=rss",
    ]
    errors = []
    for feed in feeds:
        try:
            items = read_feed(feed, limit)
            if items:
                print(json.dumps({
                    "query": query,
                    "fetchedAt": datetime.now(timezone.utc).isoformat(),
                    "feed": feed,
                    "items": items,
                }, ensure_ascii=False, indent=2))
                return
        except Exception as error:  # Report all feed failures after trying fallbacks.
            errors.append(str(error))
    raise SystemExit("No news results: " + "; ".join(errors))


if __name__ == "__main__":
    main()
