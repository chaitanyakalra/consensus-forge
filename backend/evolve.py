"""
Evolution job: learn per-intent model ordering from stored conversations.

Reads JSON conversations in data/conversations/, extracts assistant message metadata
(aggregate rankings + intent), and writes data/model_policy.json.
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any, DefaultDict, Dict, Iterable, List, Optional, Tuple

from .config import COUNCIL_MODELS, DATA_DIR


POLICY_PATH = Path("data/model_policy.json")


def _iter_conversations() -> Iterable[Dict[str, Any]]:
    data_path = Path(DATA_DIR)
    if not data_path.exists():
        return []
    conv_files = sorted(data_path.glob("*.json"))
    for p in conv_files:
        try:
            yield json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue


def _extract_training_rows(conversation: Dict[str, Any]) -> Iterable[Tuple[str, List[Dict[str, Any]]]]:
    for msg in conversation.get("messages", []) or []:
        if msg.get("role") != "assistant":
            continue
        meta = msg.get("metadata") or {}
        intent = meta.get("intent")
        rankings = meta.get("aggregate_rankings")
        if not intent or not isinstance(rankings, list) or not rankings:
            continue
        yield str(intent), rankings


def _score_from_rank(avg_rank: float) -> float:
    # Lower average_rank is better. Convert to a bounded positive score.
    # Example: rank 1 -> 1.0, rank 2 -> 0.5, rank 3 -> 0.33 ...
    try:
        r = float(avg_rank)
        if r <= 0:
            return 0.0
        return 1.0 / r
    except Exception:
        return 0.0


def compute_policy(min_samples: int = 3) -> Dict[str, Any]:
    """
    Build per-intent model policy from historical aggregate rankings.
    """
    scores: DefaultDict[str, DefaultDict[str, float]] = defaultdict(lambda: defaultdict(float))
    counts: DefaultDict[str, DefaultDict[str, int]] = defaultdict(lambda: defaultdict(int))
    intent_samples: DefaultDict[str, int] = defaultdict(int)

    for conv in _iter_conversations():
        for intent, rankings in _extract_training_rows(conv):
            intent_samples[intent] += 1
            for r in rankings:
                model = r.get("model")
                avg_rank = r.get("average_rank")
                if not model:
                    continue
                s = _score_from_rank(avg_rank)
                if s <= 0:
                    continue
                scores[intent][model] += s
                counts[intent][model] += 1

    policy: Dict[str, Any] = {
        "version": 1,
        "generated_from": str(Path(DATA_DIR)),
        "min_samples": min_samples,
        "intents": {},
        "default": {"order": COUNCIL_MODELS},
    }

    for intent, model_scores in scores.items():
        if intent_samples[intent] < min_samples:
            continue

        # Average the score per model
        avg_scores = {
            m: round(model_scores[m] / max(1, counts[intent][m]), 6)
            for m in model_scores.keys()
        }
        ordered = sorted(avg_scores.items(), key=lambda kv: kv[1], reverse=True)
        order = [m for m, _ in ordered]

        # Keep only models that are part of the configured council; append any missing configured models at end.
        configured = set(COUNCIL_MODELS)
        order = [m for m in order if m in configured] + [m for m in COUNCIL_MODELS if m not in set(order)]

        policy["intents"][intent] = {
            "order": order,
            "scores": avg_scores,
            "samples": intent_samples[intent],
        }

    return policy


def main() -> None:
    policy = compute_policy()
    POLICY_PATH.parent.mkdir(parents=True, exist_ok=True)
    POLICY_PATH.write_text(json.dumps(policy, indent=2), encoding="utf-8")
    print(f"Wrote {POLICY_PATH}")


if __name__ == "__main__":
    main()

