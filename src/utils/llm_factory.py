"""Build the configured LLM from environment variables."""

import os
from typing import Literal, cast, get_args

from openhands.sdk import LLM
from pydantic import SecretStr

from .docker import _transform_localhost_url

ReasoningEffort = Literal["low", "medium", "high", "xhigh", "none"]


def build_llm(temperature: float | None = None) -> LLM:
    """Construct the agent LLM from env vars, validating required ones.

    Recognized env: LLM_MODEL (required), LLM_API_KEY (required for non-Ollama),
    LLM_BASE_URL (required for Ollama), LLM_NUM_CTX, LLM_KEEP_ALIVE,
    LLM_INPUT_COST_PER_TOKEN, LLM_OUTPUT_COST_PER_TOKEN, LLM_REASONING_EFFORT,
    LLM_TEMPERATURE.

    ``temperature`` overrides the LLM_TEMPERATURE env var when provided; if both are
    unset the provider default is used.
    """
    model = os.environ.get("LLM_MODEL")
    api_key = os.environ.get("LLM_API_KEY")
    base_url = os.environ.get("LLM_BASE_URL")

    # Both Ollama prefixes are local Ollama. The prefix decides the API endpoint litellm
    # uses, which matters for tool calling: `ollama/` -> the legacy /api/generate completion
    # endpoint, which does NOT support native tools (the `tools` param is dropped and the
    # model returns tool_calls=null); `ollama_chat/` -> the /api/chat endpoint, which DOES.
    # Use `ollama_chat/<model>` to get working native tool calling.
    is_ollama = model is not None and (
        model.startswith("ollama/") or model.startswith("ollama_chat/")
    )

    if model is None:
        raise ValueError("LLM_MODEL environment variable is not set.")
    if api_key is None and not is_ollama:
        raise ValueError("LLM_API_KEY environment variable is not set.")
    if base_url is None and is_ollama:
        raise ValueError("LLM_BASE_URL environment variable is not set for Ollama provider.")

    base_url = _transform_localhost_url(base_url)

    # Ollama-specific parameters passed via litellm_extra_body.
    extra_body: dict = {}
    if is_ollama:
        # Context window size (num_ctx). Default: 32768.
        num_ctx_str = os.environ.get("LLM_NUM_CTX")
        extra_body["num_ctx"] = int(num_ctx_str) if num_ctx_str else 32768
        # Keep-alive duration (how long to keep the model in memory). Default: 30m.
        extra_body["keep_alive"] = os.environ.get("LLM_KEEP_ALIVE", "30m")

    # Cost tracking (optional). Defaults to $0 for local Ollama models.
    input_cost = _float_env("LLM_INPUT_COST_PER_TOKEN")
    output_cost = _float_env("LLM_OUTPUT_COST_PER_TOKEN")
    if is_ollama:
        input_cost = input_cost or 0.0
        output_cost = output_cost or 0.0

    # Reasoning effort drives how many thinking tokens the model emits — which then get
    # fed back into context every turn. Default to "low" to keep context small; override
    # with LLM_REASONING_EFFORT (e.g. "high"/"xhigh") if you need it.
    reasoning_effort_str = os.environ.get("LLM_REASONING_EFFORT", "low")
    if reasoning_effort_str not in get_args(ReasoningEffort):
        raise ValueError(
            f"LLM_REASONING_EFFORT must be one of {get_args(ReasoningEffort)}, "
            f"got {reasoning_effort_str!r}."
        )
    reasoning_effort = cast(ReasoningEffort, reasoning_effort_str)

    # Sampling temperature. The CLI override (if any) wins over LLM_TEMPERATURE; if both
    # are unset, leave it None so the provider's default is used.
    if temperature is None:
        temperature = _float_env("LLM_TEMPERATURE")
    if temperature is not None and temperature < 0:
        raise ValueError(f"Temperature must be >= 0, got {temperature}.")

    # Native (API-level) tool calling vs. prompt-based XML tool calling. Native is far
    # cheaper — XML tool calling re-sends verbose tool schemas/formatting in every turn and
    # is prone to malformed-output retries that add whole extra turns. Enable it by default;
    # set LLM_NATIVE_TOOL_CALLING=false for a model whose native tool calling is unreliable.
    native_tool_calling = _bool_env("LLM_NATIVE_TOOL_CALLING", default=True)

    return LLM(
        usage_id="agent",
        model=model,
        api_key=SecretStr(api_key) if api_key else None,
        base_url=base_url,
        reasoning_effort=reasoning_effort,
        temperature=temperature,
        litellm_extra_body=extra_body,
        input_cost_per_token=input_cost,
        output_cost_per_token=output_cost,
        native_tool_calling=native_tool_calling,
    )


def _float_env(name: str) -> float | None:
    value = os.environ.get(name)
    return float(value) if value else None


def _bool_env(name: str, *, default: bool) -> bool:
    """Parse a boolean env var. Accepts 1/0, true/false, yes/no, on/off (case-insensitive)."""
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")
