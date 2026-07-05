"""Build the configured LLM from environment variables."""

import os
from typing import Literal, cast, get_args

from openhands.sdk import LLM
from pydantic import SecretStr

from .docker import _transform_localhost_url

ReasoningEffort = Literal["low", "medium", "high", "xhigh", "none"]

# OpenCode Zen (https://opencode.ai/docs/zen): one gateway/API key for many models.
# Use `zen/<model-id>` (or OpenCode's own `opencode/<model-id>` spelling) as LLM_MODEL,
# e.g. `zen/claude-sonnet-4-6`. The gateway URL is fixed, so LLM_BASE_URL is ignored —
# a stale Ollama base URL in .env must not silently redirect Zen traffic.
ZEN_BASE_URL = "https://opencode.ai/zen"

# Zen pricing in $ per 1M tokens (input, output), from https://opencode.ai/docs/zen
# (as of 2026-07). Used for cost tracking when LLM_*_COST_PER_TOKEN are unset; litellm
# can't price these itself since Zen's rates differ from the upstream providers'.
ZEN_PRICING: dict[str, tuple[float, float]] = {
    "big-pickle": (0.0, 0.0),
    "deepseek-v4-flash-free": (0.0, 0.0),
    "mimo-v2.5-free": (0.0, 0.0),
    "north-mini-code-free": (0.0, 0.0),
    "nemotron-3-ultra-free": (0.0, 0.0),
    "minimax-m3": (0.30, 1.20),
    "minimax-m2.7": (0.30, 1.20),
    "minimax-m2.5": (0.30, 1.20),
    "glm-5.2": (1.40, 4.40),
    "glm-5.1": (1.40, 4.40),
    "glm-5": (1.00, 3.20),
    "kimi-k2.7-code": (0.95, 4.00),
    "kimi-k2.6": (0.95, 4.00),
    "kimi-k2.5": (0.60, 3.00),
    "qwen3.7-max": (2.50, 7.50),
    "qwen3.7-plus": (0.40, 1.60),
    "qwen3.6-plus": (0.50, 3.00),
    "qwen3.5-plus": (0.20, 1.20),
    "deepseek-v4-pro": (1.74, 3.48),
    "deepseek-v4-flash": (0.14, 0.28),
    "grok-build-0.1": (1.00, 2.00),
    "claude-fable-5": (10.00, 50.00),
    "claude-opus-4-8": (5.00, 25.00),
    "claude-opus-4-7": (5.00, 25.00),
    "claude-opus-4-6": (5.00, 25.00),
    "claude-opus-4-5": (5.00, 25.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-sonnet-4-5": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
    "gemini-3.5-flash": (1.50, 9.00),
    "gemini-3.1-pro": (2.00, 12.00),
    "gemini-3-flash": (0.50, 3.00),
    "gpt-5.5": (5.00, 30.00),
    "gpt-5.5-pro": (30.00, 180.00),
    "gpt-5.4": (2.50, 15.00),
    "gpt-5.4-pro": (30.00, 180.00),
    "gpt-5.4-mini": (0.75, 4.50),
    "gpt-5.4-nano": (0.20, 1.25),
    "gpt-5.3-codex": (1.75, 14.00),
    "gpt-5.3-codex-spark": (1.75, 14.00),
    "gpt-5.2": (1.75, 14.00),
    "gpt-5.2-codex": (1.75, 14.00),
    "gpt-5.1": (1.07, 8.50),
    "gpt-5.1-codex": (1.07, 8.50),
    "gpt-5.1-codex-max": (1.25, 10.00),
    "gpt-5.1-codex-mini": (0.25, 2.00),
    "gpt-5": (1.07, 8.50),
    "gpt-5-codex": (1.07, 8.50),
    "gpt-5-nano": (0.05, 0.40),
}


def _resolve_zen_model(model_id: str) -> tuple[str, str]:
    """Map a Zen model id to the (litellm model, base_url) pair that reaches it.

    Zen serves each model family over a different wire protocol, so the litellm
    route must match: Claude/Qwen speak Anthropic /v1/messages, GPT models are
    only on the OpenAI Responses API, Gemini uses Google-style per-model
    endpoints, and everything else is OpenAI-compatible /v1/chat/completions.
    """
    if not model_id:
        raise ValueError(
            "LLM_MODEL is missing the Zen model id; expected e.g. zen/claude-sonnet-4-6."
        )
    if model_id.startswith(("claude-", "qwen")):
        # litellm appends /v1/messages to the anthropic route's base URL.
        return f"anthropic/{model_id}", ZEN_BASE_URL
    if model_id.startswith("gpt-"):
        # The `responses/` prefix bridges litellm completion() onto the Responses
        # API; the OpenAI client appends /responses to the base URL.
        return f"openai/responses/{model_id}", f"{ZEN_BASE_URL}/v1"
    if model_id.startswith("gemini-"):
        # Zen's Gemini endpoints are per-model; litellm appends `:generateContent`.
        return f"gemini/{model_id}", f"{ZEN_BASE_URL}/v1/models/{model_id}"
    return f"openai/{model_id}", f"{ZEN_BASE_URL}/v1"


def build_llm(temperature: float | None = None) -> LLM:
    """Construct the agent LLM from env vars, validating required ones.

    Recognized env: LLM_MODEL (required), LLM_API_KEY (required for non-Ollama),
    LLM_BASE_URL (required for Ollama), LLM_NUM_CTX, LLM_KEEP_ALIVE,
    LLM_INPUT_COST_PER_TOKEN, LLM_OUTPUT_COST_PER_TOKEN, LLM_REASONING_EFFORT,
    LLM_TEMPERATURE.

    Prefix LLM_MODEL with ``zen/`` (or ``opencode/``) to route through the OpenCode
    Zen gateway with your Zen API key, e.g. ``zen/claude-sonnet-4-6``.

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
    is_zen = model is not None and (model.startswith("zen/") or model.startswith("opencode/"))

    if model is None:
        raise ValueError("LLM_MODEL environment variable is not set.")
    if api_key is None and not is_ollama:
        raise ValueError("LLM_API_KEY environment variable is not set.")
    if base_url is None and is_ollama:
        raise ValueError("LLM_BASE_URL environment variable is not set for Ollama provider.")

    zen_model_id: str | None = None
    if is_zen:
        zen_model_id = model.split("/", 1)[1]
        model, base_url = _resolve_zen_model(zen_model_id)

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
    elif zen_model_id is not None and zen_model_id in ZEN_PRICING:
        # Fall back to Zen's published rates so cost tracking works out of the box.
        zen_input, zen_output = ZEN_PRICING[zen_model_id]
        if input_cost is None:
            input_cost = zen_input / 1_000_000
        if output_cost is None:
            output_cost = zen_output / 1_000_000

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
