# Extending

## Change what the agent does

The opening task prompt is built in `src/utils/prompt_generator.py`. The MV2→MV3 reference
the agent consults is the `mv3-migration` skill under `src/skills/mv3-migration/SKILL.md`.

## Add a subagent

Create a markdown file in `src/agents/subagents/`. The frontmatter declares its name,
tools, and model; the body is its system prompt.

```markdown
---
name: my-agent
description: >-
  One line the orchestrator uses to decide when to delegate here.
tools:
  - terminal
  - file_editor
model: inherit
max_iteration_per_run: 20
---

System prompt for the subagent.
```

`MigratorAgent` loads everything in that directory at startup via `load_agents_from_dir`,
so the new subagent is available to the orchestrator's `task` tool without further wiring.

## Add a skill

Create a directory under `src/skills/<name>/` with a `SKILL.md` (its `name` in frontmatter
must match the directory). Anything in `src/skills/` is copied to
`/workspace/.openhands/skills/` at runtime and loaded into the agent's context. Scripts a
skill needs at runtime go in a `scripts/` subdirectory; they run in the container, so their
dependencies have to be installed there (see how `verify` installs `playwright` in
`src/utils/test_harness.py`).

## Change the API replacement table

Static analysis matches against `src/utils/api_mappings.json`. Each entry maps a deprecated
source call to its MV3 target. Adding entries here widens what `analysis.json` reports
before the agent starts.
