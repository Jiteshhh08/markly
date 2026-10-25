"""Shared AI-service test isolation.

The individual phase tests remove LLM/search environment variables so they
always exercise the stub provider. In a combined pytest run, ``test_phase8``
imports ``app.main`` during collection; that module calls ``load_dotenv()`` at
import time, which repopulated ``LLM_*`` from services/ai-service/.env after
the earlier modules had removed them. Provider selection happens at test
runtime, so earlier tests then attempted to reach the real Qwen gateway.

Disabling dotenv *for tests only* fixes the combined suite at the source.
Production ``app.main`` still calls the real ``load_dotenv``. No test module
needs the developer's .env: they all assert stub/no-provider behaviour.
"""
import os

import dotenv

# Must run before test_phase8 imports app.main. `from dotenv import load_dotenv`
# in app.main resolves this patched attribute at import time.
dotenv.load_dotenv = lambda *args, **kwargs: False

for _key in (
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL",
    "TAVILY_API_KEY",
    "SEARXNG_URL",
):
    os.environ.pop(_key, None)
