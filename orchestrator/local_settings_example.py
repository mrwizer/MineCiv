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
ACTOR_KEY  = "REPLACE_WITH_YOUR_ACTOR_KEY"
CRITIC_KEY = "REPLACE_WITH_YOUR_CRITIC_KEY"
VLLM_KEY   = "REPLACE_WITH_YOUR_VLLM_KEY"    # shared key for the vLLM boxes

# --- endpoint URLs -----------------------------------------------------------
# Full OpenAI-compatible chat-completions URLs for each serving box.
ACTOR_URL  = "http://ACTOR_HOST:8888/v1/chat/completions"
CRITIC_URL = "http://CRITIC_HOST:8888/v1/chat/completions"
QWEN_A_URL = "http://VLLM_HOST_1:8000/v1/chat/completions"
QWEN_B_URL = "http://VLLM_HOST_1:8001/v1/chat/completions"
QWEN_C_URL = "http://VLLM_HOST_2:8002/v1/chat/completions"
QWEN_D_URL = "http://VLLM_HOST_2:8003/v1/chat/completions"

# --- served model names ------------------------------------------------------
# The --served-model-name each box answers to (must match, or you get 404s).
ACTOR_MODEL  = "your-actor-model"
CRITIC_MODEL = "your-critic-model"
VLLM_MODEL   = "your-vllm-model"
