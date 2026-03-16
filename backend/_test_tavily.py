import asyncio

from backend.websearch import tavily_search, extract_compact_results
from backend.config import TAVILY_API_KEY


async def main() -> None:
    print("TAVILY_API_KEY loaded:", bool(TAVILY_API_KEY))
    if not TAVILY_API_KEY:
        return
    res = await tavily_search(api_key=TAVILY_API_KEY, query="NIFTY 50 today", max_results=2)
    compact = extract_compact_results(res)
    print("results_count:", len(compact))
    if compact:
        first = compact[0]
        print("first_url:", first.url)
        print("first_title:", first.title)


if __name__ == "__main__":
    asyncio.run(main())

