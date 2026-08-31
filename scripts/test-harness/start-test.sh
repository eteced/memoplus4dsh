#!/usr/bin/env bash
# start-test.sh — boot an isolated dsh web instance with memoplus4dsh loaded.
#
# Layout (defaults; override with MEMOPLUS4DSH_TEST_DIR):
#   dsh-install/   npm project holding @deepseek-ai/dsh (kept across resets)
#   dsh-home/      isolated DSH_HOME (wiped by reset-test.sh)
#   logs/web.log   web server log
#   run/web.pid    server pid; run/web.url  authenticated URL (with token)
#
# The server binds 127.0.0.1 on an OS-assigned free port (--port 0), runs with
# cwd = the test directory, and its profile pins sandbox-policy to
# workspace-write with workspaceRoot = the test directory.
#
# Re-entrant: if the server is already running this prints its URL and exits 0.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="${MEMOPLUS4DSH_TEST_DIR:-$(cd "$PLUGIN_DIR/.." && pwd)/test}"
# Node/npm must be on PATH; set NODE_BIN to prepend a specific bin directory.
if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN/npm" ]]; then export PATH="$NODE_BIN:$PATH"; fi

export DSH_HOME="$TEST_DIR/dsh-home"
DSH_BIN="$TEST_DIR/dsh-install/node_modules/.bin/dsh"
DSH_VERSION="0.1.2-alpha.3"
RUN_DIR="$TEST_DIR/run"
LOG_DIR="$TEST_DIR/logs"
PID_FILE="$RUN_DIR/web.pid"
URL_FILE="$RUN_DIR/web.url"
LOG_FILE="$LOG_DIR/web.log"

mkdir -p "$RUN_DIR" "$LOG_DIR"

# --- already running? -------------------------------------------------------
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "dsh web already running (pid $(cat "$PID_FILE"))"
  [[ -f "$URL_FILE" ]] && cat "$URL_FILE"
  exit 0
fi
rm -f "$PID_FILE"

# --- install dsh (cached across resets) -------------------------------------
if [[ ! -x "$DSH_BIN" ]]; then
  echo "==> installing @deepseek-ai/dsh@$DSH_VERSION into test/dsh-install"
  mkdir -p "$TEST_DIR/dsh-install"
  (cd "$TEST_DIR/dsh-install" \
    && [[ -f package.json ]] || npm init -y >/dev/null)
  (cd "$TEST_DIR/dsh-install" \
    && npm install --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION")
fi

# --- install the plugin into the web profile --------------------------------
"$PLUGIN_DIR/scripts/install.sh" --profile web --dsh-home "$DSH_HOME"

# --- pin sandbox-policy for the test instance --------------------------------
# The base bundle defaults to workspace-write + workspaceRoot=process.cwd();
# we launch with cwd=$TEST_DIR and also restate the row explicitly so the
# policy does not depend on the caller's directory.
PATCH_FILE="$DSH_HOME/profiles/web/cordis.patch.yml"
BLOCK_FILE="$(mktemp /tmp/dsh-test-harness-block.XXXXXX.yml)"
trap 'rm -f "$BLOCK_FILE"' EXIT
cat > "$BLOCK_FILE" <<EOF
- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: '$TEST_DIR'
EOF
python3 "$PLUGIN_DIR/scripts/_patch_yml.py" "$PATCH_FILE" "dsh-test-harness" add "$BLOCK_FILE"

# --- boot-free proof the plugin is in the composed tree ----------------------
echo "==> composed config entries matching memoplus4dsh / sandbox-policy:"
"$DSH_BIN" web --dump-config | grep -A5 -E 'id: (memoplus4dsh|sandbox-policy)' || {
  echo "start-test.sh: plugin missing from composed config" >&2; exit 1; }

# --- launch ------------------------------------------------------------------
echo "==> starting dsh web (127.0.0.1, OS-assigned port, cwd=$TEST_DIR)"
cd "$TEST_DIR"
# The log is appended across runs; only scan content written after this
# offset, or a restart would match the previous instance's stale URL line.
LOG_OFFSET=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
nohup "$DSH_BIN" web --host 127.0.0.1 --port 0 --no-open >>"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

# --- wait for the readiness line and extract the authenticated URL -----------
URL=""
for _ in $(seq 1 90); do
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "start-test.sh: dsh web exited during boot; last log lines:" >&2
    tail -20 "$LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
  fi
  URL="$(tail -c "+$((LOG_OFFSET + 1))" "$LOG_FILE" | grep -oE 'http://127\.0\.0\.1:[0-9]+[^ ]*' | tail -1 || true)"
  [[ -n "$URL" ]] && break
  sleep 1
done
if [[ -z "$URL" ]]; then
  echo "start-test.sh: no URL line within 90s; last log lines:" >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
fi
echo "$URL" > "$URL_FILE"

echo "==> dsh web up (pid $(cat "$PID_FILE"))"
echo "    URL:   $URL"
echo "    log:   $LOG_FILE"

# --- runtime proof the plugin fiber is active ---------------------------------
# The shipped web profile mounts no console logger, so the plugin's
# 'memory plugin loaded' line never reaches web.log. Instead query the
# host's pluginInventory Remote over /api: exchange the launch token for the
# signed cookie, then POST the RPC envelope (payload = exactly one args
# object).
BASE_URL="${URL%%\?*}"
BASE_URL="${BASE_URL%/}"
COOKIE_JAR="$(mktemp /tmp/dsh-test-cookies.XXXXXX.txt)"
trap 'rm -f "$BLOCK_FILE" "$COOKIE_JAR"' EXIT
curl -s -c "$COOKIE_JAR" -o /dev/null "$URL"
INVENTORY="$(curl -s -b "$COOKIE_JAR" -X POST "$BASE_URL/api/pluginInventory/list" \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"start-test","method":"pluginInventory/list","payload":{"args":{}}}')"
if echo "$INVENTORY" | grep -q '"moduleName":"memoplus4dsh","enabled":true,"fiberPhase":"active"'; then
  echo "    plugin: pluginInventory reports memoplus4dsh ACTIVE"
else
  echo "    plugin: WARNING pluginInventory did not report memoplus4dsh active:" >&2
  echo "$INVENTORY" | head -c 400 >&2; echo >&2
fi
