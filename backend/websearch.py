"""Web search utilities (Tavily)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

import httpx


TAVILY_SEARCH_URL = "https://api.tavily.com/search"


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str


def detect_search_needed(query: str) -> bool:
    """
    Conservative heuristic: only search when the user likely needs freshness or explicitly asks.
    """
    if not query:
        return False
    q = query.lower()
    triggers = [
        "search the web",
        "web search",
        "google",
        "bing",
        "duckduckgo",
        "latest",
        "today",
        "this week",
        "this month",
        "current",
        "right now",
        "news",
        "breaking",
        "price",
        "stock",
        "release",
        "changelog",
        "2026",
        "yesterday",
        "last 24 hours",
        "last week",
    ]
    return any(t in q for t in triggers)


async def tavily_search(
    *,
    api_key: str,
    query: str,
    max_results: int = 5,
    search_depth: str = "basic",
    topic: str = "general",
    time_range: Optional[str] = None,
    client: Optional[httpx.AsyncClient] = None,
    timeout_s: float = 20.0,
) -> Dict[str, Any]:
    """
    Execute a Tavily search.

    Returns the raw JSON response (caller can extract desired fields).
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload: Dict[str, Any] = {
        "query": query,
        "max_results": max(0, min(int(max_results), 10)),
        "search_depth": search_depth,
        "topic": topic,
    }
    if time_range:
        payload["time_range"] = time_range

    async def _do(c: httpx.AsyncClient) -> Dict[str, Any]:
        r = await c.post(TAVILY_SEARCH_URL, headers=headers, json=payload)
        r.raise_for_status()
        return r.json()

    if client is not None:
        return await _do(client)

    async with httpx.AsyncClient(timeout=timeout_s) as c:
        return await _do(c)


def extract_compact_results(raw: Dict[str, Any]) -> List[SearchResult]:
    results = []
    for r in (raw or {}).get("results", []) or []:
        title = str(r.get("title") or "").strip()
        url = str(r.get("url") or "").strip()
        snippet = str(r.get("content") or r.get("snippet") or "").strip()
        if not url:
            continue
        results.append(SearchResult(title=title or url, url=url, snippet=snippet))
    return results


def build_evidence_pack(query: str, results: Sequence[SearchResult]) -> str:
    ts = datetime.now(timezone.utc).isoformat()
    lines = [
        "WEB_SEARCH_EVIDENCE (Tavily)",
        f"timestamp_utc: {ts}",
        f"query: {query}",
        "",
    ]
    if not results:
        lines.append("No results found.")
        return "\n".join(lines).strip()

    for i, r in enumerate(results, start=1):
        lines.append(f"[{i}] {r.title}")
        lines.append(f"url: {r.url}")
        if r.snippet:
            lines.append(f"snippet: {r.snippet}")
        lines.append("")

    lines.append(
        "Instruction: Use ONLY the evidence above for claims that require up-to-date facts. "
        "When you cite something, include the matching URL."
    )
    return "\n".join(lines).strip()

