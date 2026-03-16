"""
CLI interface for ConsensusForge council.

This module provides a command-line interface that can be called
from OpenClaw (Node.js) to execute the consensus council.
"""

import asyncio
import json
import sys
import argparse
from typing import Optional
from pathlib import Path

from .council import run_full_council
from .storage import (
    get_conversation,
    create_conversation,
    add_user_message,
    add_assistant_message,
    update_conversation_title
)


async def run_council_cli(
    query: str,
    conversation_id: Optional[str] = None,
    intent: Optional[str] = None,
    evidence_pack: Optional[str] = None,
    search_meta: Optional[dict] = None,
) -> dict:
    """
    Run the council and return results as JSON.
    """
    try:
        import time
        start = time.time()
        print(f"[cli.py] 🚀 Starting council for query: \"{query[:80]}...\"", file=sys.stderr)
        print(f"[cli.py]   conversation_id: {conversation_id}", file=sys.stderr)
        print(f"[cli.py]   intent: {intent}", file=sys.stderr)
        print(f"[cli.py]   evidence_pack: {'yes' if evidence_pack else 'no'}", file=sys.stderr)
        
        # Run the full 3-stage council process
        print(f"[cli.py] ⏳ Calling run_full_council()...", file=sys.stderr)
        stage1, stage2, stage3, metadata = await run_full_council(
            query,
            intent=intent,
            evidence_pack=evidence_pack,
            search_meta=search_meta,
        )
        elapsed = time.time() - start
        print(f"[cli.py] ✅ Council completed in {elapsed:.1f}s", file=sys.stderr)
        print(f"[cli.py]   stage1 models: {len(stage1)}", file=sys.stderr)
        print(f"[cli.py]   stage2 rankings: {len(stage2)}", file=sys.stderr)
        print(f"[cli.py]   stage3 response length: {len(stage3.get('response', '')) if isinstance(stage3, dict) else 'N/A'}", file=sys.stderr)
        
        # Build the response object
        result = {
            "success": True,
            "query": query,
            "conversation_id": conversation_id,
            "intent": intent,
            "stage1": [
                {"model": r["model"], "response": r["response"]}
                for r in stage1
            ],
            "stage2": [
                {
                    "model": r["model"],
                    "ranking": r["ranking"],
                    "parsed_ranking": r.get("parsed_ranking", [])
                }
                for r in stage2
            ],
            "stage3": stage3,
            "metadata": metadata
        }
        
        # Save to conversation history if conversation_id is provided
        if conversation_id:
            try:
                # Get or create conversation
                conversation = get_conversation(conversation_id)
                if conversation is None:
                    conversation = create_conversation(conversation_id)
                
                # Add user message
                add_user_message(conversation_id, query)
                
                # Add assistant message with all stages
                add_assistant_message(conversation_id, stage1, stage2, stage3, metadata)
                
            except Exception as e:
                # Don't fail the whole operation if saving fails
                result["save_error"] = str(e)
        
        print(f"[cli.py] 📤 Returning result (success=True)", file=sys.stderr)
        return result
        
    except Exception as e:
        print(f"[cli.py] ❌ EXCEPTION: {type(e).__name__}: {e}", file=sys.stderr)
        return {
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        }


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Run the ConsensusForge LLM Council"
    )
    parser.add_argument(
        "--query",
        type=str,
        required=True,
        help="The user's question to send to the council"
    )
    parser.add_argument(
        "--conversation-id",
        type=str,
        help="Optional conversation ID for tracking"
    )
    parser.add_argument(
        "--intent",
        type=str,
        help="Optional intent label (simple/moderate/high_stakes/dangerous) for evolution",
    )
    parser.add_argument(
        "--evidence-pack-file",
        type=str,
        help="Optional path to a text file containing router-provided web search evidence pack",
    )
    parser.add_argument(
        "--search-meta",
        type=str,
        help="Optional JSON string with router-provided search metadata",
    )
    
    args = parser.parse_args()
    
    print(f"[cli.py] 🏁 CLI started with query: \"{args.query[:80]}...\"", file=sys.stderr)
    
    # Debug: Check environment and API key
    from .config import OPENROUTER_API_KEY, OPENROUTER_API_URL
    import os
    dotenv_path = os.path.join(os.getcwd(), '.env')
    print(f"[cli.py] 📂 CWD: {os.getcwd()}", file=sys.stderr)
    print(f"[cli.py] 📂 .env exists at CWD: {os.path.exists(dotenv_path)}", file=sys.stderr)
    if OPENROUTER_API_KEY:
        masked = OPENROUTER_API_KEY[:12] + "..." + OPENROUTER_API_KEY[-4:]
        print(f"[cli.py] 🔑 API Key loaded: {masked} (length: {len(OPENROUTER_API_KEY)})", file=sys.stderr)
    else:
        print(f"[cli.py] ❌ API KEY IS NONE! .env not loaded or key missing!", file=sys.stderr)
    print(f"[cli.py] 🌐 API URL: {OPENROUTER_API_URL}", file=sys.stderr)
    
    # Run the async council function
    evidence_pack = None
    if args.evidence_pack_file:
        try:
            evidence_pack = Path(args.evidence_pack_file).read_text(encoding="utf-8")
        except Exception as e:
            print(f"[cli.py] ⚠️ failed to read evidence pack file: {e}", file=sys.stderr)

    search_meta = None
    if args.search_meta:
        try:
            search_meta = json.loads(args.search_meta)
        except Exception as e:
            print(f"[cli.py] ⚠️ failed to parse search_meta JSON: {e}", file=sys.stderr)

    result = asyncio.run(run_council_cli(args.query, args.conversation_id, args.intent, evidence_pack, search_meta))
    
    # Output JSON to stdout (this is what Node.js will parse)
    json_output = json.dumps(result, indent=2)
    print(f"[cli.py] 📤 Writing {len(json_output)} bytes of JSON to stdout", file=sys.stderr)
    print(json_output)
    
    # Exit with appropriate code
    success = result.get("success")
    print(f"[cli.py] 🏁 Exiting with code {0 if success else 1}", file=sys.stderr)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
