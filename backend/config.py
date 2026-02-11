"""Configuration for the LLM Council."""

import os
from dotenv import load_dotenv

load_dotenv()

# OpenRouter API key
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

# Council members - list of OpenRouter model identifiers (FREE models)
COUNCIL_MODELS = [
    "openrouter/free",  # Special router model that uses free models
    "z-ai/glm-4.5-air:free",
    "tngtech/deepseek-r1t2-chimera:free",
    "stepfun/step-3.5-flash:free",
    "arcee-ai/trinity-large-preview:free",
]

# Chairman model - synthesizes final response (using a free model)
CHAIRMAN_MODEL = "openrouter/free"

# OpenRouter API endpoint
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Data directory for conversation storage
DATA_DIR = "data/conversations"
