"""Configuration for the LLM Council."""

import os
from dotenv import load_dotenv
import sys
from pathlib import Path

# Always let .env override any pre-set env vars so local config wins.
# Resolve the project root explicitly so we reliably load the right .env.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DOTENV_PATH = PROJECT_ROOT / ".env"
load_dotenv(dotenv_path=DOTENV_PATH, override=True)

# OpenRouter API key
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

# Tavily API key (web search)
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")

if OPENROUTER_API_KEY:
    masked = OPENROUTER_API_KEY[:8] + "..." + OPENROUTER_API_KEY[-4:]
    print(f"[config] 🔑 OPENROUTER_API_KEY loaded ({len(OPENROUTER_API_KEY)} chars) -> {masked}", file=sys.stderr)
else:
    print("[config] ❌ OPENROUTER_API_KEY is missing; council cannot call OpenRouter.", file=sys.stderr)

if TAVILY_API_KEY:
    masked_tv = TAVILY_API_KEY[:8] + "..." + TAVILY_API_KEY[-4:]
    print(f"[config] 🌐 TAVILY_API_KEY loaded ({len(TAVILY_API_KEY)} chars) -> {masked_tv}", file=sys.stderr)
else:
    print("[config] ⚠️  TAVILY_API_KEY not set; web search inside council will be disabled.", file=sys.stderr)

# Council members
COUNCIL_MODELS = [
    "google/gemma-3n-e4b-it:free",
    "microsoft/phi-3-mini-128k-instruct:free",
    "qwen/qwen2.5-7b-instruct:free",
    "deepseek/deepseek-chat:free",
]

# Chairman model - synthesizes final response
CHAIRMAN_MODEL = "google/gemma-3n-e4b-it:free"

# Per-model timeout in seconds - skip slow models, never stall pipeline
MODEL_TIMEOUT_SECONDS = 15

# OpenRouter API endpoint
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Data directory for conversation storage
DATA_DIR = "data/conversations"

# Decision log file for routing analytics
DECISION_LOG_PATH = "data/decisions.log"
