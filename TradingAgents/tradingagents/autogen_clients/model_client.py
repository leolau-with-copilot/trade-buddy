"""Model-client factory for the three supported providers.

All three are OpenAI-compatible, so they share one
:class:`autogen_ext.models.openai.OpenAIChatCompletionClient` with a per-model
``model_info`` (AutoGen requires it for any model it does not recognise):

* **deepseek**   — ``deepseek-reasoner`` (deep reasoning, no tools) and
  ``deepseek-chat`` (tool-capable). Needs the reasoning_content round-trip.
* **openrouter** — any model id, routed through openrouter.ai.
* **ollama**     — local/remote models; no API key required.

LangChain has been removed; this is the only LLM-client layer.
"""

from __future__ import annotations

import os
import warnings
from typing import Any, Optional

from autogen_core.models import AssistantMessage, ModelFamily, ModelInfo
from autogen_ext.models.openai import OpenAIChatCompletionClient

# AutoGen warns ("Resolved model mismatch: … Model mapping in
# autogen_ext.models.openai may be incorrect") whenever we use a model id it
# doesn't recognise — every DeepSeek/OpenRouter/Ollama call. It only affects
# AutoGen's *estimated* token counts (we read real usage from the API response),
# and it printed mid-render and corrupted the CLI's live display. Silence it.
warnings.filterwarnings("ignore", message="Resolved model mismatch")

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OLLAMA_BASE_URL_DEFAULT = "http://localhost:11434/v1"

SUPPORTED_PROVIDERS = ("deepseek", "openrouter", "ollama")

# Provider -> API-key env var (None = no key required).
PROVIDER_API_KEY_ENV = {
    "deepseek": "DEEPSEEK_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "ollama": None,
}

# Models with no reliable function calling — never hand them tools.
_NON_TOOL_MODELS = frozenset({"deepseek-reasoner"})


def is_tool_calling_model(model: str) -> bool:
    """Whether ``model`` can be safely given tools (deepseek-reasoner cannot)."""
    return model not in _NON_TOOL_MODELS


def _model_info_for(provider: str, model: str) -> ModelInfo:
    tool_calling = is_tool_calling_model(model)
    family = ModelFamily.R1 if model == "deepseek-reasoner" else ModelFamily.UNKNOWN
    return ModelInfo(
        vision=False,
        function_calling=tool_calling,
        json_output=True,
        family=family,
        # DeepSeek (and most OpenAI-compatible third parties) reject OpenAI's
        # json_schema response_format, so structured output is OFF — typed output
        # comes from prompting for JSON and parsing it (autogen_agents/structured.py).
        structured_output=False,
        multiple_system_messages=False,
    )


class _DeepSeekChatCompletionClient(OpenAIChatCompletionClient):
    """DeepSeek client with the thinking-mode ``reasoning_content`` round-trip.

    DeepSeek's thinking models return ``reasoning_content`` and **require it
    echoed back** on the assistant message in every later turn, or the API
    returns HTTP 400. AutoGen captures it into ``AssistantMessage.thought`` but
    never re-emits it; we re-attach it here at the ``_process_create_args`` seam.
    Turns without a thought are left untouched (safe no-op).
    """

    def _process_create_args(self, messages, tools, tool_choice, json_output, extra_create_args):  # type: ignore[override]
        params = super()._process_create_args(
            messages, tools, tool_choice, json_output, extra_create_args
        )
        thoughts = [m.thought for m in messages if isinstance(m, AssistantMessage)]
        idx = 0
        for msg in params.messages:
            if msg.get("role") != "assistant":
                continue
            thought = thoughts[idx] if idx < len(thoughts) else None
            idx += 1
            if not thought:
                continue
            msg["reasoning_content"] = thought
            if msg.get("tool_calls") and msg.get("content") == thought:
                msg["content"] = ""
        return params


def create_model_client(
    model: str,
    *,
    provider: str = "deepseek",
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    **kwargs: Any,
) -> OpenAIChatCompletionClient:
    """Create an AutoGen model client for one of the supported providers.

    Args:
        model: model id (e.g. ``deepseek-chat``, ``openai/gpt-4o-mini`` on
            OpenRouter, ``llama3.1`` on Ollama).
        provider: one of ``deepseek`` / ``openrouter`` / ``ollama``.
        base_url: override the provider endpoint (e.g. a remote Ollama).
        api_key: explicit key; otherwise read from the provider's env var.

    Raises:
        ValueError: unknown provider, or a required API key is missing.
    """
    provider = provider.lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError(
            f"Unsupported provider '{provider}'. Supported: {', '.join(SUPPORTED_PROVIDERS)}."
        )

    if provider == "ollama":
        resolved_base = base_url or os.environ.get("OLLAMA_BASE_URL") or OLLAMA_BASE_URL_DEFAULT
        resolved_key = api_key or os.environ.get("OLLAMA_API_KEY") or "ollama"
    else:
        resolved_base = base_url or (
            DEEPSEEK_BASE_URL if provider == "deepseek" else OPENROUTER_BASE_URL
        )
        env_var = PROVIDER_API_KEY_ENV[provider]
        resolved_key = api_key or os.environ.get(env_var)
        if not resolved_key:
            raise ValueError(
                f"API key for provider '{provider}' is not set. Please set the "
                f"{env_var} environment variable (e.g. add {env_var}=your_key to .env)."
            )

    cls = _DeepSeekChatCompletionClient if provider == "deepseek" else OpenAIChatCompletionClient
    return cls(
        model=model,
        base_url=resolved_base,
        api_key=resolved_key,
        model_info=_model_info_for(provider, model),
        **kwargs,
    )
