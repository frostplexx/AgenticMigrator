# pi-container-spike

Exploratory proof for [`docs/pi-container-plan.md`](../docs/pi-container-plan.md): can a
**self-rolled container** (no OpenHands agent-server) run **headed Chromium under Xvfb** to
load an MV3 extension, and host the **pi SDK** in-process? If yes, the riskiest part of the
Path B rewrite is retired.

## What it proves

1. **Headed extension load under Xvfb** (`verify.mjs`) — the real unknown. MV3 extensions
   won't load in `--headless=new`, so the image runs Xvfb and Chromium headed, exactly like
   the OpenHands image did, but self-built.
2. **pi SDK in-container** (`run-migration.mjs`) — the framework imports, constructs a
   session, registers a custom tool (subagent stand-in), and exposes the event stream. Runs
   creds-free (stops before the first model call) or does one live turn if `LLM_MODEL` + a
   key are set.

## Files

| File | Role |
|---|---|
| `Dockerfile` | Playwright base + `xvfb x11vnc fluxbox novnc websockify tini` + deps |
| `entrypoint.sh` | tini → start Xvfb (readiness-gated) → optional VNC → `exec "$@"` |
| `verify.mjs` | headed Playwright load + MV3 service-worker check (Node port of `browser_session.py`) |
| `run-migration.mjs` | pi SDK skeleton (session + custom tool + event stream) |
| `fixtures/migrated-mv3/` | positive case — should **PASS** (SW registers) |
| `fixtures/unmigrated-mv2/` | negative case — should **FAIL** (no MV3 SW) |
| `flake.nix` | `nix develop` → node + npm + esbuild for host-side iteration |

## Run

```sh
docker build -t pi-container-spike:latest .

# Positive: migrated MV3 → expect result: PASS, exit 0
docker run --rm --init --shm-size=1g pi-container-spike:latest \
  node verify.mjs fixtures/migrated-mv3

# Negative: unmigrated MV2 → expect result: FAIL, exit 1
docker run --rm --init --shm-size=1g pi-container-spike:latest \
  node verify.mjs fixtures/unmigrated-mv2

# pi SDK skeleton (creds-free is fine)
docker run --rm --init pi-container-spike:latest node run-migration.mjs

# Watch Chrome load the extension live over VNC
docker run --rm --init --shm-size=1g -e ENABLE_VNC=1 -p 6080:6080 \
  pi-container-spike:latest node verify.mjs fixtures/migrated-mv3
# → open http://localhost:6080/vnc.html
```

`--shm-size=1g` + `--init` are the two Docker-specific must-haves (Chrome shm crash / zombie
reaping). Local Ollama: add `--add-host=host.docker.internal:host-gateway` and
`-e LLM_BASE_URL=http://host.docker.internal:11434`.

## Not in scope (deliberately)

Chrome-for-Testing version pin (uses Playwright's bundled Chromium here), the real
transformer subagent, static analysis / converter / batch / memory — all straight ports once
the container is proven. See the plan's §10 rollout.
