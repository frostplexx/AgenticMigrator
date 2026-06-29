"""Build the optional per-run Critic from environment variables.

A Critic governs each inner ``agent.run()``: with ``iterative_refinement`` it can re-run and
refine the agent's work mid-run before the run is allowed to finish. This composes with the
goal-completion loop in ``manager`` — the critic improves each run, the goal loop decides
whether to re-prompt at all.

``APIBasedCritic`` calls an external critic model (by default the all-hands llm-proxy), so it
needs ``CRITIC_API_KEY``. When that is unset the critic is disabled (``None``) and agents run
without one — this keeps the local-Ollama, no-cloud path working unchanged.
"""

import os

from openhands.sdk.critic import APIBasedCritic, CriticBase, IterativeRefinementConfig


def build_critic() -> CriticBase | None:
    """Return an ``APIBasedCritic`` configured from env, or ``None`` if disabled.

    Recognized env: CRITIC_API_KEY (required to enable), CRITIC_SERVER_URL,
    CRITIC_MODEL_NAME, CRITIC_SUCCESS_THRESHOLD, CRITIC_MAX_ITERATIONS.
    """
    api_key = os.environ.get("CRITIC_API_KEY")
    if not api_key:
        return None

    # Only override the SDK's IterativeRefinementConfig defaults that were actually set.
    refinement_kwargs: dict = {}
    threshold = _float_env("CRITIC_SUCCESS_THRESHOLD")
    if threshold is not None:
        refinement_kwargs["success_threshold"] = threshold
    max_iters = _int_env("CRITIC_MAX_ITERATIONS")
    if max_iters is not None:
        refinement_kwargs["max_iterations"] = max_iters

    kwargs: dict = {
        "api_key": api_key,
        "iterative_refinement": IterativeRefinementConfig(**refinement_kwargs),
    }
    server_url = os.environ.get("CRITIC_SERVER_URL")
    if server_url:
        kwargs["server_url"] = server_url
    model_name = os.environ.get("CRITIC_MODEL_NAME")
    if model_name:
        kwargs["model_name"] = model_name

    return APIBasedCritic(**kwargs)


def _float_env(name: str) -> float | None:
    value = os.environ.get(name)
    return float(value) if value else None


def _int_env(name: str) -> int | None:
    value = os.environ.get(name)
    return int(value) if value else None
