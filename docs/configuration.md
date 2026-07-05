# Configuration

Copy `.env.example` to `.env` and set the variables below.

| Variable | Description |
|---|---|
| `LLM_MODEL` | Model identifier, e.g. `claude-sonnet-4-6`, `zen/claude-sonnet-4-6`, or `ollama/llama3`. Required. |
| `LLM_API_KEY` | API key. Required unless the model is an Ollama model. |
| `LLM_BASE_URL` | Base URL. Required for Ollama, e.g. `http://localhost:11434`. Ignored for Zen (the gateway URL is fixed). |
| `LLM_REASONING_EFFORT` | `low`, `medium`, `high`, `xhigh`, or `none`. Defaults to `low`. |
| `LLM_TEMPERATURE` | Sampling temperature (≥ 0). Optional; defaults to the provider's default. Overridden by `--temperature`. |
| `LLM_INPUT_COST_PER_TOKEN` | Optional, for cost tracking. |
| `LLM_OUTPUT_COST_PER_TOKEN` | Optional, for cost tracking. |
| `LLM_NUM_CTX` | Ollama only. Context window size, default 32768. |
| `LLM_KEEP_ALIVE` | Ollama only. How long to keep the model loaded, default `30m`. |
| `GOAL` | Goal-completion loop. On by default; `GOAL=0` or `--no-goal` to skip. |
| `GOAL_MAX_ITERATIONS` | Max judge audit rounds before the goal loop gives up. Default 3. `--goal-iterations`. |
| `CRITIC_API_KEY` | Enables the per-run `APIBasedCritic` on subagents. Unset = disabled (default). |
| `CRITIC_SERVER_URL` | Critic model endpoint. Default the all-hands llm-proxy. |
| `CRITIC_MODEL_NAME` | Critic model name. Default `critic`. |
| `CRITIC_SUCCESS_THRESHOLD` | Min critic score to let a run finish (else refine). Default 0.6. |
| `CRITIC_MAX_ITERATIONS` | Max mid-run refinement passes per run. Default 3. |

## Providers

- Anthropic, OpenAI, or any litellm-compatible API: set `LLM_MODEL` and `LLM_API_KEY`.
- Ollama (local): prefix the model with `ollama/` and set `LLM_BASE_URL`. No API key needed.
- [OpenCode Zen](https://opencode.ai/docs/zen) (gateway to many curated models): prefix the
  model with `zen/` (or `opencode/`) and set `LLM_API_KEY` to your Zen key, e.g.
  `LLM_MODEL=zen/claude-sonnet-4-6`. `LLM_BASE_URL` is ignored (the gateway URL is
  fixed, so a stale Ollama base URL cannot redirect Zen traffic). Any model id from
  [the Zen catalog](https://opencode.ai/docs/zen#endpoints) works — Claude/Qwen,
  GPT, Gemini, and OpenAI-compatible families are routed to the right Zen endpoint
  automatically, and per-token costs for cost tracking are filled in from Zen's
  published pricing unless `LLM_INPUT_COST_PER_TOKEN`/`LLM_OUTPUT_COST_PER_TOKEN`
  override them.

## Temperature

Set a default with `LLM_TEMPERATURE` in `.env`, or override it per run with the
`--temperature/-t` option on either command (handy for research sweeps):

```bash
agentictester migrate ./ext --temperature 0
agentictester batch ./corpus --workers 4 --temperature 0.7
```

The CLI value wins over `LLM_TEMPERATURE`; if neither is set the provider default is used.
The temperature in effect for a bulk run is recorded in `runs/<timestamp>/run_config.json`.

## Goal completion loop

Verification only checks that the extension *works*. On by default, a stricter quality gate
runs after verification: an independent judge LLM (the OpenHands SDK's `run_goal`) audits the
conversation transcript for authoritative evidence that the migration objective is *provably*
complete and returns a verdict `{score, complete, missing}`. While the judge is not satisfied
and the iteration budget remains, the orchestrator is re-prompted with what is still
`missing` and runs again. The output is re-verified afterwards so a goal-driven change that
regresses correctness is reported honestly.

```bash
agentictester migrate ./ext --goal-iterations 5
agentictester batch ./corpus --workers 4 --no-goal   # skip it to save cost
```

The judge's final `goal_status` (`complete`/`capped`), `goal_score` (0.0–1.0), and
`goal_iterations` are recorded per extension (in `MigrationResult`, `summary.csv`, and
`results.jsonl`), and the batch `aggregate.json` reports `goal_complete` and `mean_goal_score`.
The judge runs under its own `goal-judge` usage_id so its cost is tracked separately. The loop
adds LLM cost, so turn it off with `--no-goal` (or `GOAL=0`) if you need to.

## Per-run critic (optional)

The goal loop governs the *overall* objective; a [Critic](https://docs.openhands.dev/sdk/agent-features/critic)
governs each individual `run()`. When `CRITIC_API_KEY` is set, an `APIBasedCritic` is attached
to the work subagents (`extension-transformer`): it scores each run and, via the SDK's
iterative refinement, makes the subagent improve its work mid-run before the run is allowed to
finish. The two compose — the critic improves each run, the goal loop decides whether to
re-prompt at all.

It is disabled unless `CRITIC_API_KEY` is set, because `APIBasedCritic` calls an external
critic model (the all-hands llm-proxy by default); this keeps the local-Ollama path working
with no cloud dependency. Tune it with `CRITIC_SERVER_URL`, `CRITIC_MODEL_NAME`,
`CRITIC_SUCCESS_THRESHOLD`, and `CRITIC_MAX_ITERATIONS` (see the table above).

## Keeping requests inside the context window

`reasoning_effort` defaults to `low` because higher settings make the model emit large
thinking blocks that are then re-sent every turn. History is also condensed once it grows
past a threshold (see `src/agents/migrator.py`). For Ollama, set `LLM_NUM_CTX` to the
model's real context window so the prompt is not silently truncated.
