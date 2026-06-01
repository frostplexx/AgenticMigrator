# Configuration

Copy `.env.example` to `.env` and set the variables below.

| Variable | Description |
|---|---|
| `LLM_MODEL` | Model identifier, e.g. `claude-sonnet-4-6` or `ollama/llama3`. Required. |
| `LLM_API_KEY` | API key. Required unless the model is an Ollama model. |
| `LLM_BASE_URL` | Base URL. Required for Ollama, e.g. `http://localhost:11434`. |
| `LLM_REASONING_EFFORT` | `low`, `medium`, `high`, `xhigh`, or `none`. Defaults to `low`. |
| `LLM_INPUT_COST_PER_TOKEN` | Optional, for cost tracking. |
| `LLM_OUTPUT_COST_PER_TOKEN` | Optional, for cost tracking. |
| `LLM_NUM_CTX` | Ollama only. Context window size, default 32768. |
| `LLM_KEEP_ALIVE` | Ollama only. How long to keep the model loaded, default `30m`. |

## Providers

- Anthropic, OpenAI, or any litellm-compatible API: set `LLM_MODEL` and `LLM_API_KEY`.
- Ollama (local): prefix the model with `ollama/` and set `LLM_BASE_URL`. No API key needed.

## Keeping requests inside the context window

`reasoning_effort` defaults to `low` because higher settings make the model emit large
thinking blocks that are then re-sent every turn. History is also condensed once it grows
past a threshold (see `src/agents/migrator.py`). For Ollama, set `LLM_NUM_CTX` to the
model's real context window so the prompt is not silently truncated.
