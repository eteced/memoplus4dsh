#!/usr/bin/env bash
# stop-test.sh — stop the dsh web test instance started by start-test.sh.
# Re-entrant: exits 0 when nothing is running.
set -euo pipefail

TEST_DIR="/home/claw/kimi_code_workspace/test"
PID_FILE="$TEST_DIR/run/web.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "no pid file at $PID_FILE; nothing to stop"
  exit 0
fi
PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "stale pid file (pid $PID not running); removing"
  rm -f "$PID_FILE"
  exit 0
fi

echo "==> stopping dsh web (pid $PID)"
kill "$PID"
for _ in $(seq 1 10); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  echo "==> still alive after 10s; sending SIGKILL"
  kill -9 "$PID" || true
fi
rm -f "$PID_FILE"
echo "==> stopped"
