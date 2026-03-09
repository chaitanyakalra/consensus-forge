"""3-stage LLM Council orchestration."""

from typing import List, Dict, Any, Tuple
import sys
import asyncio
from .openrouter import query_models_parallel, query_model
from .config import COUNCIL_MODELS, CHAIRMAN_MODEL

# Per-chairman-attempt timeout — prevents one slow model from blocking 6+ minutes
CHAIRMAN_TIMEOUT = 30.0


async def stage1_collect_responses(user_query: str) -> List[Dict[str, Any]]:
    """
    Stage 1: Collect individual responses from all council models.

    Args:
        user_query: The user's question

    Returns:
        List of dicts with 'model' and 'response' keys
    """
    messages = [{"role": "user", "content": user_query}]

    # Query all models in parallel
    responses = await query_models_parallel(COUNCIL_MODELS, messages)

    # Format results
    stage1_results = []
    for model, response in responses.items():
        if response is not None:  # Only include successful responses
            stage1_results.append({
                "model": model,
                "response": response.get('content', '')
            })

    return stage1_results


async def stage2_collect_rankings(
    user_query: str,
    stage1_results: List[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """
    Stage 2: Each model ranks the anonymized responses.

    Args:
        user_query: The original user query
        stage1_results: Results from Stage 1

    Returns:
        Tuple of (rankings list, label_to_model mapping)
    """
    # Create anonymized labels for responses (Response A, Response B, etc.)
    labels = [chr(65 + i) for i in range(len(stage1_results))]  # A, B, C, ...

    # Create mapping from label to model name
    label_to_model = {
        f"Response {label}": result['model']
        for label, result in zip(labels, stage1_results)
    }

    # Build the ranking prompt
    responses_text = "\n\n".join([
        f"Response {label}:\n{result['response']}"
        for label, result in zip(labels, stage1_results)
    ])

    ranking_prompt = f"""You are evaluating different responses to the following question:

Question: {user_query}

Here are the responses from different models (anonymized):

{responses_text}

Your task:
1. First, evaluate each response individually. For each response, explain what it does well and what it does poorly.
2. Then, at the very end of your response, provide a final ranking.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Then list the responses from best to worst as a numbered list
- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response A")
- Do not add any other text or explanations in the ranking section

Example of the correct format for your ENTIRE response:

Response A provides good detail on X but misses Y...
Response B is accurate but lacks depth on Z...
Response C offers the most comprehensive answer...

FINAL RANKING:
1. Response C
2. Response A
3. Response B

Now provide your evaluation and ranking:"""

    messages = [{"role": "user", "content": ranking_prompt}]

    # Get rankings from all council models in parallel
    responses = await query_models_parallel(COUNCIL_MODELS, messages)

    # Format results
    stage2_results = []
    for model, response in responses.items():
        if response is not None:
            full_text = response.get('content', '')
            parsed = parse_ranking_from_text(full_text)
            stage2_results.append({
                "model": model,
                "ranking": full_text,
                "parsed_ranking": parsed
            })

    return stage2_results, label_to_model


def _is_meta_commentary(text: str) -> bool:
    """Check if the chairman response is meta-commentary about drafts instead of a real reply."""
    if not text or len(text.strip()) < 5:
        return True
    lower = text.lower().strip()
    # Reject responses that reference draft labels or evaluation language
    meta_patterns = [
        "response a", "response b", "response c", "response d",
        "draft 1", "draft 2", "draft 3", "draft 4",
        "offers a clearer approach",
        "aligning perfectly with",
        "the best response",
        "the chosen response",
        "i would select",
        "i choose",
        "i recommend response",
        "based on the evaluation",
        "based on the ranking",
        "peer evaluation",
        "the ranking shows",
    ]
    for pattern in meta_patterns:
        if pattern in lower:
            return True
    return False


async def stage3_synthesize_final(
    user_query: str,
    stage1_results: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Stage 3: Chairman synthesizes final response.

    Args:
        user_query: The original user query
        stage1_results: Individual model responses from Stage 1
        stage2_results: Rankings from Stage 2

    Returns:
        Dict with 'model' and 'response' keys
    """
    # Anonymize drafts — use numbered labels, hide model names
    stage1_text = "\n\n".join([
        f"--- Draft {i+1} ---\n{result['response']}"
        for i, result in enumerate(stage1_results)
    ])

    # Simplify peer evaluations — just show the consensus ranking order
    ranking_summary_parts = []
    for result in stage2_results:
        parsed = result.get("parsed_ranking", [])
        if parsed:
            ranking_summary_parts.append(", ".join(parsed))
    ranking_summary = "\n".join(ranking_summary_parts) if ranking_summary_parts else "No clear ranking consensus."

    # Retry logic for chairman
    BACKUP_CHAIRMAN = "google/gemma-3n-e4b-it:free"  # tested, ~1s

    async def try_synthesize(model_name: str) -> Dict[str, Any]:
        """Attempt synthesis with a specific model, with a hard timeout."""
        try:
            result = await asyncio.wait_for(
                query_model(model_name, [{"role": "user", "content": chairman_prompt}]),
                timeout=CHAIRMAN_TIMEOUT
            )
            return result
        except asyncio.TimeoutError:
            print(f"  [TIMEOUT] Chairman {model_name} timed out after {CHAIRMAN_TIMEOUT}s", file=sys.stderr)
            return None

    chairman_prompt = f"""Below are several draft replies that were written for the user's question. Read them, pick the strongest ideas, and write your own final reply.

USER'S QUESTION:
{user_query}

DRAFTS (for reference only — do not mention these):
{stage1_text}

────────────────────────
ABSOLUTE RULES — violating ANY of these makes your answer invalid:
• Output ONLY the final message the user should see — nothing else.
• Write as a single AI assistant talking directly to the user.
• NEVER reference "Draft 1/2/3", "Response A/B/C", rankings, evaluations, or a selection process.
• NEVER say things like "offers a clearer approach", "aligning perfectly", "the best response is", or any similar meta-commentary about the drafts.
• NEVER add a preamble, explanation, or justification.
• If the user asked for code, provide the actual code — not a description of which draft had better code.
• Start your reply as if you are answering the user from scratch.
────────────────────────

Your reply to the user:"""

    # Attempt 1-3: Main Chairman Model
    for attempt in range(3):
        print(f"  ... Chairman synthesis attempt {attempt + 1}/3 with {CHAIRMAN_MODEL}...", file=sys.stderr)
        response = await try_synthesize(CHAIRMAN_MODEL)
        if response:
            content = response.get('content', '')
            if _is_meta_commentary(content):
                print(f"  ⚠️ Attempt {attempt + 1} returned meta-commentary, retrying...", file=sys.stderr)
                continue
            return {"model": CHAIRMAN_MODEL, "response": content}

    # Fallback: Backup Model
    print(f"  ! Chairman failed/meta 3 times. Trying backup: {BACKUP_CHAIRMAN}...", file=sys.stderr)
    response = await try_synthesize(BACKUP_CHAIRMAN)
    
    if response:
        content = response.get('content', '')
        if not _is_meta_commentary(content):
            return {
                "model": BACKUP_CHAIRMAN,
                "response": content
            }

    # Ultimate fallback: return the top-ranked Stage 1 response directly
    # This is better than returning meta-commentary
    print(f"  ! All synthesis attempts failed or returned meta-commentary.", file=sys.stderr)
    print(f"  ! Falling back to top-ranked Stage 1 response.", file=sys.stderr)
    if stage1_results:
        # Try to find the top-ranked response from stage2 parsed rankings
        for result in stage2_results:
            parsed = result.get("parsed_ranking", [])
            if parsed:
                top_label = parsed[0]  # e.g., "Response A"
                # Extract the letter index (A=0, B=1, etc.)
                letter = top_label.replace("Response ", "").strip().upper()
                idx = ord(letter) - ord('A') if len(letter) == 1 else 0
                if 0 <= idx < len(stage1_results):
                    return {
                        "model": stage1_results[idx]["model"] + " (direct-fallback)",
                        "response": stage1_results[idx]["response"]
                    }
        # If no ranking info, just use first response
        return {
            "model": stage1_results[0]["model"] + " (direct-fallback)",
            "response": stage1_results[0]["response"]
        }

    return {
        "model": "system-error",
        "response": "Error: Council chairman and backup model both failed to synthesize a response."
    }


def parse_ranking_from_text(ranking_text: str) -> List[str]:
    """
    Parse the FINAL RANKING section from the model's response.

    Args:
        ranking_text: The full text response from the model

    Returns:
        List of response labels in ranked order
    """
    import re

    # Look for "FINAL RANKING:" section
    if "FINAL RANKING:" in ranking_text:
        # Extract everything after "FINAL RANKING:"
        parts = ranking_text.split("FINAL RANKING:")
        if len(parts) >= 2:
            ranking_section = parts[1]
            # Try to extract numbered list format (e.g., "1. Response A")
            # This pattern looks for: number, period, optional space, "Response X"
            numbered_matches = re.findall(r'\d+\.\s*Response [A-Z]', ranking_section)
            if numbered_matches:
                # Extract just the "Response X" part
                return [re.search(r'Response [A-Z]', m).group() for m in numbered_matches]

            # Fallback: Extract all "Response X" patterns in order
            matches = re.findall(r'Response [A-Z]', ranking_section)
            return matches

    # Fallback: try to find any "Response X" patterns in order
    matches = re.findall(r'Response [A-Z]', ranking_text)
    return matches


def calculate_aggregate_rankings(
    stage2_results: List[Dict[str, Any]],
    label_to_model: Dict[str, str]
) -> List[Dict[str, Any]]:
    """
    Calculate aggregate rankings across all models.

    Args:
        stage2_results: Rankings from each model
        label_to_model: Mapping from anonymous labels to model names

    Returns:
        List of dicts with model name and average rank, sorted best to worst
    """
    from collections import defaultdict

    # Track positions for each model
    model_positions = defaultdict(list)

    for ranking in stage2_results:
        ranking_text = ranking['ranking']

        # Parse the ranking from the structured format
        parsed_ranking = parse_ranking_from_text(ranking_text)

        for position, label in enumerate(parsed_ranking, start=1):
            if label in label_to_model:
                model_name = label_to_model[label]
                model_positions[model_name].append(position)

    # Calculate average position for each model
    aggregate = []
    for model, positions in model_positions.items():
        if positions:
            avg_rank = sum(positions) / len(positions)
            aggregate.append({
                "model": model,
                "average_rank": round(avg_rank, 2),
                "rankings_count": len(positions)
            })

    # Sort by average rank (lower is better)
    aggregate.sort(key=lambda x: x['average_rank'])

    return aggregate


async def generate_conversation_title(user_query: str) -> str:
    """
    Generate a short title for a conversation based on the first user message.

    Args:
        user_query: The first user message

    Returns:
        A short title (3-5 words)
    """
    title_prompt = f"""Generate a very short title (3-5 words maximum) that summarizes the following question.
The title should be concise and descriptive. Do not use quotes or punctuation in the title.

Question: {user_query}

Title:"""

    messages = [{"role": "user", "content": title_prompt}]

    # Use a free model for title generation
    response = await query_model(CHAIRMAN_MODEL, messages, timeout=30.0)

    if response is None:
        # Fallback to a generic title
        return "New Conversation"

    title = response.get('content', 'New Conversation').strip()

    # Clean up the title - remove quotes, limit length
    title = title.strip('"\'')

    # Truncate if too long
    if len(title) > 50:
        title = title[:47] + "..."

    return title


async def run_full_council(user_query: str) -> Tuple[List, List, Dict, Dict]:
    """
    Run the complete 3-stage council process.

    Args:
        user_query: The user's question

    Returns:
        Tuple of (stage1_results, stage2_results, stage3_result, metadata)
    """
    # Stage 1: Collect individual responses
    stage1_results = await stage1_collect_responses(user_query)

    # If no models responded successfully, return error
    if not stage1_results:
        return [], [], {
            "model": "error",
            "response": "All models failed to respond. Please try again."
        }, {}

    # Stage 2: Collect rankings
    stage2_results, label_to_model = await stage2_collect_rankings(user_query, stage1_results)

    # Calculate aggregate rankings
    aggregate_rankings = calculate_aggregate_rankings(stage2_results, label_to_model)

    # Stage 3: Synthesize final answer
    stage3_result = await stage3_synthesize_final(
        user_query,
        stage1_results,
        stage2_results
    )

    # Prepare metadata
    metadata = {
        "label_to_model": label_to_model,
        "aggregate_rankings": aggregate_rankings
    }

    return stage1_results, stage2_results, stage3_result, metadata
