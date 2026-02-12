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

from .council import run_full_council
from .storage import (
    get_conversation,
    create_conversation,
    add_user_message,
    add_assistant_message,
    update_conversation_title
)


async def run_council_cli(query: str, conversation_id: Optional[str] = None) -> dict:
    """
    Run the council and return results as JSON.
    
    Args:
        query: The user's question
        conversation_id: Optional conversation ID for tracking
        
    Returns:
        Dict containing the full council results
    """
    try:
        # Run the full 3-stage council process
        stage1, stage2, stage3, metadata = await run_full_council(query)
        
        # Build the response object
        result = {
            "success": True,
            "query": query,
            "conversation_id": conversation_id,
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
                add_assistant_message(conversation_id, stage1, stage2, stage3)
                
            except Exception as e:
                # Don't fail the whole operation if saving fails
                result["save_error"] = str(e)
        
        return result
        
    except Exception as e:
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
    
    args = parser.parse_args()
    
    # Run the async council function
    result = asyncio.run(run_council_cli(args.query, args.conversation_id))
    
    # Output JSON to stdout (this is what Node.js will parse)
    print(json.dumps(result, indent=2))
    
    # Exit with appropriate code
    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
