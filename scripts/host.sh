#!/usr/bin/env bash
#
# Start, stop and inspect the extlens host.
#
# The host is a long-running background process, and the usual way to deal with one — find it in
# `ps aux | grep node`, kill what looks right — is both tedious and dangerous: the migrator itself
# runs node, so the pattern that finds the server also finds things you did not mean to kill.
#
# So the process is tracked. `start` records its process group and the arguments it was given;
# `stop` kills that group and nothing else; `restart` reuses the recorded arguments, which is what
# you want after rebuilding the SDK or pulling a change. State lives in .host/ (gitignored):
#
#   .host/host.pgid   process group to signal
#   .host/host.args   the arguments start was given, so restart needs none
#   .host/host.log    stdout and stderr, since a detached process has nowhere else to put them
#
# Usage:
#   scripts/host.sh start [args…]   start detached; args are passed to the CLI and remembered
#   scripts/host.sh stop            stop it
#   scripts/host.sh restart [args…] stop, then start with the given args or the remembered ones
#   scripts/host.sh status          running? since when? on which port?
#   scripts/host.sh logs [-f]       show the log, optionally following it
#
# .env (tracked: settings) and .env.local (gitignored: secrets such as LLM_API_KEY) are both
# loaded on start, so a restart needs no environment juggling.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/.host"
PGID_FILE="$STATE/host.pgid"
ARGS_FILE="$STATE/host.args"
LOG_FILE="$STATE/host.log"

# Every process of ours has this in its command line; used to make sure a recycled pid or process
# group is not mistaken for the host.
MARKER="src/cli.ts"

mkdir -p "$STATE"

die() { printf '%s\n' "$*" >&2; exit 1; }

# The recorded process group, if it is still alive and still ours.
running_pgid() {
  [[ -f "$PGID_FILE" ]] || return 1
  local pgid; pgid="$(cat "$PGID_FILE")"
  [[ -n "$pgid" ]] || return 1
  # A process group with no members is gone; one whose members are not the host means the id was
  # recycled, and signalling it would kill something unrelated.
  pgrep -g "$pgid" >/dev/null 2>&1 || return 1
  pgrep -g "$pgid" -a 2>/dev/null | grep -q -- "$MARKER" || return 1
  printf '%s' "$pgid"
}

port_of() {
  # The port the server reported, from its own log; falls back to the protocol default.
  grep -oE 'ws://[^ ]+:[0-9]+' "$LOG_FILE" 2>/dev/null | tail -1 | grep -oE '[0-9]+$' || printf '8081'
}

cmd_start() {
  if pgid="$(running_pgid)"; then
    die "already running (process group $pgid) — use 'restart', or 'stop' first"
  fi

  local args=("$@")
  if [[ ${#args[@]} -eq 0 && -f "$ARGS_FILE" ]]; then
    # Remembered from the last start, so a bare `start` after a reboot still works.
    mapfile -t args < "$ARGS_FILE"
  fi
  printf '%s\n' "${args[@]:-}" > "$ARGS_FILE"

  # A detached process inherits whatever environment `start` had, which in practice means the
  # caller has to remember LLM_API_KEY on every restart. Reading .env removes that step — it is
  # the file those values already live in, and secretspec is not consulted for what is set here.
  # .env is tracked in this repo, so it holds settings (model, base url) and must never hold a
  # secret. .env.local is gitignored and loaded second, which is where LLM_API_KEY belongs.
  for envfile in "$ROOT/.env" "$ROOT/.env.local"; do
    [[ -f "$envfile" ]] || continue
    set -a
    # shellcheck disable=SC1090
    source "$envfile"
    set +a
  done

  : > "$LOG_FILE"
  # setsid puts the host in its own process group, which is what makes `stop` able to kill the
  # whole tree (npm → sh → node) without hunting for children. Without it, killing the parent
  # leaves the node process holding the port.
  local launcher=(setsid)
  command -v setsid >/dev/null 2>&1 || launcher=()   # macOS: fall back to a plain background job
  "${launcher[@]}" npx tsx "$ROOT/src/cli.ts" "${args[@]:-}" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  disown 2>/dev/null || true

  # With setsid the child leads its own group, so its pid IS the group id.
  local pgid; pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  printf '%s' "${pgid:-$pid}" > "$PGID_FILE"

  # Wait for the server to announce itself rather than claiming success the instant fork returns:
  # a bad key or a port clash fails within a second or two, and silence would hide it.
  for _ in $(seq 1 40); do
    if grep -q 'extlens server on' "$LOG_FILE" 2>/dev/null; then
      printf 'host started (process group %s) on port %s\n' "$(cat "$PGID_FILE")" "$(port_of)"
      return 0
    fi
    if ! running_pgid >/dev/null; then
      printf 'host exited during startup:\n\n' >&2
      tail -n 15 "$LOG_FILE" >&2
      rm -f "$PGID_FILE"
      return 1
    fi
    sleep 0.5
  done
  printf 'host is running (process group %s) but has not reported a port yet — see %s\n' \
    "$(cat "$PGID_FILE")" "$LOG_FILE"
}

cmd_stop() {
  local pgid
  if ! pgid="$(running_pgid)"; then
    rm -f "$PGID_FILE"
    printf 'not running\n'
    return 0
  fi
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    running_pgid >/dev/null || { rm -f "$PGID_FILE"; printf 'stopped\n'; return 0; }
    sleep 0.5
  done
  # It had ten seconds to close its sockets; a migration mid-flight does not get to hold the port.
  kill -KILL -- "-$pgid" 2>/dev/null || true
  rm -f "$PGID_FILE"
  printf 'stopped (forced)\n'
}

cmd_status() {
  local pgid
  if ! pgid="$(running_pgid)"; then
    printf 'not running\n'
    [[ -f "$ARGS_FILE" ]] && printf 'last args: %s\n' "$(tr '\n' ' ' < "$ARGS_FILE")"
    return 1
  fi
  printf 'running (process group %s) on port %s\n' "$pgid" "$(port_of)"
  printf 'since:     %s\n' "$(ps -o lstart= -p "$pgid" 2>/dev/null | sed 's/^ *//')"
  printf 'args:      %s\n' "$(tr '\n' ' ' < "$ARGS_FILE" 2>/dev/null)"
  printf 'log:       %s\n' "$LOG_FILE"
  # The SDK probe warns here when the loaded extlens-sdk predates the current analyzer; it is the
  # first thing worth seeing, because it explains an otherwise baffling review form.
  if grep -q 'extlens-sdk is out of date' "$LOG_FILE" 2>/dev/null; then
    printf '\nWARNING: %s\n' "$(grep -m1 'extlens-sdk is out of date' "$LOG_FILE")"
  fi
}

cmd_logs() {
  [[ -f "$LOG_FILE" ]] || die "no log yet at $LOG_FILE"
  if [[ "${1:-}" == "-f" ]]; then tail -f "$LOG_FILE"; else tail -n "${1:-40}" "$LOG_FILE"; fi
}

case "${1:-}" in
  start)   shift; cmd_start "$@" ;;
  stop)    cmd_stop ;;
  restart) shift; cmd_stop; cmd_start "$@" ;;
  status)  cmd_status ;;
  logs)    shift; cmd_logs "$@" ;;
  *)       die "usage: $0 {start [args…]|stop|restart [args…]|status|logs [-f|N]}" ;;
esac
