# Project structure

```
.
├── main.py                         # Entrypoint
├── src/
│   ├── manager.py                  # MigrationManager: orchestrates the migrate() flow
│   ├── agents/
│   │   ├── migrator.py             # MigratorAgent: orchestrator with the task tool
│   │   └── subagents/
│   │       ├── extension-transformer.md  # Applies the migration, writes to out/
│   │       └── extension-tester.md       # Runs the verify skill, reports errors
│   ├── skills/                     # Copied to /workspace/.openhands/skills at runtime
│   │   ├── verify/                 # Playwright load + exercise + error capture
│   │   │   ├── SKILL.md
│   │   │   └── scripts/            # verify.py, browser_session.py, exerciser.py, …
│   │   └── mv3-migration/          # MV2→MV3 reference, pulled on demand
│   │       └── SKILL.md
│   ├── utils/
│   │   ├── banner.py               # Startup banner
│   │   ├── docker.py               # Docker workspace factory
│   │   ├── llm_factory.py          # Builds the LLM from env vars
│   │   ├── manifest_converter.py   # Host-side extension-manifest-converter pre-pass
│   │   ├── static_analyzer.py      # Scans for deprecated APIs, builds analysis.json
│   │   ├── prompt_generator.py     # The initial task prompt
│   │   ├── workspace_io.py         # Assemble / upload / download the container workspace
│   │   ├── conversation_loops.py   # Activity logger + nudge loop + verify/fix loop
│   │   ├── artifacts.py            # Download outputs + build migration.patch
│   │   └── test_harness.py         # Installs verify deps + runs the verify skill
│   └── utils/api_mappings.json     # MV2→MV3 call-site replacement table
├── third_party/
│   └── extension-manifest-converter/   # git submodule: GoogleChromeLabs MV2→MV3 converter
├── output/                         # Run output (created at runtime)
│   ├── extension/                  #   the migrated extension
│   ├── analysis.json               #   migration plan from static analysis
│   ├── migration.patch             #   unified diff, original → migrated
│   └── test_report.json            #   verification report
├── agent_logs/                     # Per-agent logs (created at runtime)
├── pyproject.toml
├── flake.nix
└── uv.lock
```
