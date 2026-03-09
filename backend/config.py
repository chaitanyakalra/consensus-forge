"""Configuration for the LLM Council."""

import os
from dotenv import load_dotenv

load_dotenv()

# OpenRouter API key
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

# Council members - LIVE TESTED and confirmed working on OpenRouter free tier (2026-03-09)
COUNCIL_MODELS = [
    "stepfun/step-3.5-flash:free",            # ~2.5s ✅ tested
    "arcee-ai/trinity-large-preview:free",    # ~1.6s ✅ tested
    "google/gemma-3-12b-it:free",             # ~3.4s ✅ tested
    "google/gemma-3n-e4b-it:free",            # ~1.0s ✅ tested
]

# Chairman model - synthesizes final response (fast + reliable)
CHAIRMAN_MODEL = "arcee-ai/trinity-large-preview:free"

# Per-model timeout in seconds - skip slow models, never stall pipeline
MODEL_TIMEOUT_SECONDS = 15

# OpenRouter API endpoint
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Data directory for conversation storage
DATA_DIR = "data/conversations"

# Decision log file for routing analytics
DECISION_LOG_PATH = "data/decisions.log"
