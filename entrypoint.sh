#!/usr/bin/env bash
# Bring up the display stack, then exec the passed command (e.g. `node verify.mjs <dir>`)
# in the foreground so its exit == the container's exit. Runs under tini (PID 1).
set -euo pipefail

# Pretty logging that matches the Node/winston format (dim time, padded level, right-aligned
# module │ message) so entrypoint lines and the migrator's logs read as one stream. Uses the
# container clock (UTC, per Dockerfile TZ) so timestamps line up with the node logs that follow.
_log() { printf '\033[2m%s\033[0m \033[90m%-7s\033[0m \033[2m%8s\033[0m \033[2m│\033[0m %s\n' "$(date +%H:%M:%S)" "$1" "entry" "$2"; }
log()  { _log "INFO" "$*"; }
err()  { printf '\033[2m%s\033[0m \033[31m%-7s\033[0m \033[2m%8s\033[0m \033[2m│\033[0m %s\n' "$(date +%H:%M:%S)" "ERROR" "entry" "$*"; }

: "${DISPLAY:=:99}"
export DISPLAY

# --- Xvfb: the virtual X server that lets Chromium run HEADED (required for MV3 loads) ---
Xvfb "$DISPLAY" -screen 0 1280x1024x24 -ac -nolisten tcp -noreset >/tmp/xvfb.log 2>&1 &

# Readiness gate: block until the X server answers, else Chrome races it with
# "cannot open display".
ok=0
for _ in $(seq 1 100); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.1
done
[ "$ok" = 1 ] || { err "Xvfb failed to start:"; cat /tmp/xvfb.log; exit 1; }
log "Xvfb ready on $DISPLAY"

# --- Optional VNC for live debugging (off in batch; ENABLE_VNC=1 to watch Chrome) ---
if [ "${ENABLE_VNC:-0}" = "1" ]; then
  fluxbox >/tmp/fluxbox.log 2>&1 &
  x11vnc -display "$DISPLAY" -forever -shared -nopw -bg -rfbport 5900 >/tmp/x11vnc.log 2>&1
  websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
  log "VNC enabled — noVNC :6080, x11vnc :5900"
fi

log "exec: $*"
exec "$@"
