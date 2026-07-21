"""local_settings_example.py — TEMPLATE. Safe to commit (contains no real secrets).

SETUP: copy this file to local_settings.py and fill in your real tokens + box
addresses. local_settings.py is git-ignored so your secrets never get committed.

    cp orchestrator/local_settings_example.py orchestrator/local_settings.py
    # then edit orchestrator/local_settings.py

llm.py imports from local_settings.py; if it's missing, llm.py falls back to THIS
example (placeholders) and prints a warning so nothing crashes on first checkout.

(Not named secrets.py on purpose — that would shadow Python's stdlib `secrets` module.)
"""

# --- API tokens --------------------------------------------------------------
# The bearer token each model server expects (whatever you passed to --api-key).
# If a server was started without --api-key, any non-empty string works.
ACTOR_KEY  = "REPLACE_WITH_YOUR_ACTOR_KEY"     # V100 coder (hands)
CRITIC_KEY = "REPLACE_WITH_YOUR_CRITIC_KEY"    # Mac judge (critic)
VLLM_KEY   = "REPLACE_WITH_YOUR_VLLM_KEY"      # DGX strategist (mind)

# --- endpoint URLs -----------------------------------------------------------
# Full OpenAI-compatible chat-completions URLs for each serving box. THREE roles:
#   actor  = fast coder (code-gen/revise/naming)   -- llama.cpp
#   critic = judge (grades success)                -- llama.cpp
#   dgx    = strategist / "mind" (strategy/design/lesson + society) -- vLLM, shared by all bots
ACTOR_URL  = "http://ACTOR_HOST:8888/v1/chat/completions"
CRITIC_URL = "http://CRITIC_HOST:8888/v1/chat/completions"
DGX_URL    = "http://DGX_HOST:8000/v1/chat/completions"

# --- served model names ------------------------------------------------------
# The --served-model-name each box answers to (must match, or you get 404s).
ACTOR_MODEL  = "your-coder-model"
CRITIC_MODEL = "your-judge-model"
DGX_MODEL    = "your-strategist-model"
