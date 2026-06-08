# Configuration

Copy `.env.example` to `.env` and set the variables below.

| Variable | Description |
|---|---|
| `LLM_MODEL` | Model identifier, e.g. `claude-sonnet-4-6` or `ollama/llama3`. Required. |
| `LLM_API_KEY` | API key. Required unless the model is an Ollama model. |
| `LLM_BASE_URL` | Base URL. Required for Ollama, e.g. `http://localhost:11434`. |
| `LLM_REASONING_EFFORT` | `low`, `medium`, `high`, `xhigh`, or `none`. Defaults to `low`. |
| `LLM_TEMPERATURE` | Sampling temperature (≥ 0). Optional; defaults to the provider's default. Overridden by `--temperature`. |
| `LLM_INPUT_COST_PER_TOKEN` | Optional, for cost tracking. |
| `LLM_OUTPUT_COST_PER_TOKEN` | Optional, for cost tracking. |
| `LLM_NUM_CTX` | Ollama only. Context window size, default 32768. |
| `LLM_KEEP_ALIVE` | Ollama only. How long to keep the model loaded, default `30m`. |
| `REFINE` | Iterative quality-refinement loop. On by default; `REFINE=0` or `--no-refine` to skip. |
| `REFINE_THRESHOLD` | Stop refining once the critic's average score reaches this (0-100). Default 80. `--refine-threshold`. |
| `REFINE_MAX_ITERATIONS` | Max critique/improvement passes. Default 2. `--refine-iterations`. |

## Providers

- Anthropic, OpenAI, or any litellm-compatible API: set `LLM_MODEL` and `LLM_API_KEY`.
- Ollama (local): prefix the model with `ollama/` and set `LLM_BASE_URL`. No API key needed.

## Temperature

Set a default with `LLM_TEMPERATURE` in `.env`, or override it per run with the
`--temperature/-t` option on either command (handy for research sweeps):

```bash
agentictester migrate ./ext --temperature 0
agentictester batch ./corpus --workers 4 --temperature 0.7
```

The CLI value wins over `LLM_TEMPERATURE`; if neither is set the provider default is used.
The temperature in effect for a bulk run is recorded in `runs/<timestamp>/run_config.json`.

## Iterative refinement

Verification only checks that the extension *works*. On by default, a second,
quality-focused loop runs after a passing verification: the `extension-critic` agent scores
the migration 0–100 across correctness, completeness, code quality, and MV3 best practices
and writes `critique.json`; if the average is below `--refine-threshold`, the
`extension-transformer` agent addresses the critique and the migration is re-scored, up to
`--refine-iterations` times. The output is re-verified afterwards so a refinement that
regresses correctness is reported honestly.

```bash
agentictester migrate ./ext --refine-threshold 85 --refine-iterations 3
agentictester batch ./corpus --workers 4 --no-refine   # skip it to save cost
```

The final `quality_score` and the number of refinement passes are recorded per extension
(in `MigrationResult`, `summary.csv`, and `results.jsonl`), and the batch `aggregate.json`
reports `mean_quality_score`. Refinement adds LLM cost, so pass `--no-refine` (or `REFINE=0`)
to turn it off.

## Keeping requests inside the context window

`reasoning_effort` defaults to `low` because higher settings make the model emit large
thinking blocks that are then re-sent every turn. History is also condensed once it grows
past a threshold (see `src/agents/migrator.py`). For Ollama, set `LLM_NUM_CTX` to the
model's real context window so the prompt is not silently truncated.
