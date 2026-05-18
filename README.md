# Agentic Migrator of Chrome Extensions


```
.
├── src/
│   ├── agents/
│   │   ├── __init__.py
│   │   ├── migrator.py        # main orchestrator agent
│   │   └── subagents/
│   │       ├── analyzer.py    # inspects extension structure
│   │       ├── transformer.py # applies migrations
│   │       └── validator.py   # verifies output
│   ├── skills/
│   │   ├── __init__.py
│   │   ├── codeql.py          # your CodeQL query gen
│   │   ├── ast_rewriter.py
│   │   └── manifest_parser.py
│   ├── utils/
│   │   └── banner.py          # already exists
│   └── manager.py             # already exists — wires agents + skills
├── workspace/                 # runtime: input/output extensions land here
│   ├── input/
│   └── output/
├── tests/
│   ├── agents/
│   ├── skills/
│   └── fixtures/              # sample extensions for testing
├── main.py                    # already exists — entrypoint
├── pyproject.toml
├── flake.nix
├── flake.lock
├── uv.lock
├── .env.example
└── README.md
```
