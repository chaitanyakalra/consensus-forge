"""OpenRouter API client for making LLM requests."""

import sys
import time
import asyncio
import httpx
from typing import List, Dict, Any, Optional
from .config import OPENROUTER_API_KEY, OPENROUTER_API_URL

# Default per-model timeout (seconds) used in parallel queries
MODEL_TIMEOUT = 60.0


async def query_model(
    model: str,
    messages: List[Dict[str, str]],
    timeout: float = 120.0,
    client: Optional[httpx.AsyncClient] = None,
) -> Optional[Dict[str, Any]]:
    """
    Query a single model via OpenRouter API.

    Args:
        model: OpenRouter model identifier (e.g., "openai/gpt-4o")
        messages: List of message dicts with 'role' and 'content'
        timeout: Request timeout in seconds
        client: Optional shared httpx.AsyncClient (one will be created if not provided)

    Returns:
        Response dict with 'content' and optional 'reasoning_details', or None if failed
    """
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model,
        "messages": messages,
    }

    async def _do_request(c: httpx.AsyncClient) -> Optional[Dict[str, Any]]:
        response = await c.post(
            OPENROUTER_API_URL,
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        message = data['choices'][0]['message']
        return {
            'content': message.get('content'),
            'reasoning_details': message.get('reasoning_details'),
        }

    try:
        if client is not None:
            return await _do_request(client)
        else:
            async with httpx.AsyncClient(timeout=timeout) as c:
                return await _do_request(c)
    except Exception as e:
        print(f"Error querying model {model}: {e}", file=sys.stderr)
        return None


async def query_models_parallel(
    models: List[str],
    messages: List[Dict[str, str]],
) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Query multiple models in parallel (no staggered delays).

    All models are fired simultaneously.  Each individual call is
    wrapped in a per-model timeout so that one slow / hanging model
    cannot block the entire council stage.

    Args:
        models: List of OpenRouter model identifiers
        messages: List of message dicts to send to each model

    Returns:
        Dict mapping model identifier to response dict (or None if failed)
    """

    stage_start = time.perf_counter()

    async def _query_with_timeout(
        model: str, client: httpx.AsyncClient
    ) -> Optional[Dict[str, Any]]:
        model_start = time.perf_counter()
        try:
            result = await asyncio.wait_for(
                query_model(model, messages, client=client),
                timeout=MODEL_TIMEOUT,
            )
            elapsed = time.perf_counter() - model_start
            print(f"  [OK] {model} responded in {elapsed:.1f}s", file=sys.stderr)
            return result
        except asyncio.TimeoutError:
            elapsed = time.perf_counter() - model_start
            print(f"  [TIMEOUT] {model} timed out after {elapsed:.1f}s", file=sys.stderr)
            return None

    # Use a single shared client for all parallel requests
    async with httpx.AsyncClient(timeout=MODEL_TIMEOUT) as client:
        tasks = [_query_with_timeout(m, client) for m in models]
        responses = await asyncio.gather(*tasks)

    stage_elapsed = time.perf_counter() - stage_start
    print(f"  -- stage completed in {stage_elapsed:.1f}s ({len(models)} models)", file=sys.stderr)

    return {model: resp for model, resp in zip(models, responses)}
