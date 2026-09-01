#!/usr/bin/env bash
# uninstall.sh — remove memoplus4dsh from a dsh profile, reversing install.sh.
#
#   1. Removes the managed insert block from the profile's cordis.patch.yml
#      (restoring the `[]` placeholder when no entries remain).
#   2. Removes the npm "file:" dependency and the node_modules symlink.
# The profile directory itself (and any other plugins) is left untouched.
# Safe to run when the plugin is not installed.
#
# Usage:
#   uninstall.sh [--profile <name>] [--dsh-home <path>]
# Defaults: --profile web, dsh home = $DSH_HOME or ~/.dsh.
set -euo pipefail

PROFILE="web"
DSH_HOME_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --dsh-home) DSH_HOME_ARG="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "uninstall.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME_RESOLVED="${DSH_HOME_ARG:-${DSH_HOME:-$HOME/.dsh}}"
PROFILE_DIR="$DSH_HOME_RESOLVED/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
MARKER="memoplus4dsh"

# Node/npm must be on PATH; set NODE_BIN to prepend a specific bin directory.
if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN/npm" ]]; then export PATH="$NODE_BIN:$PATH"; fi

if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "==> profile '$PROFILE' does not exist at $PROFILE_DIR; nothing to do"
  exit 0
fi

if [[ -f "$PATCH_FILE" ]]; then
  command -v python3 >/dev/null || { echo "uninstall.sh: python3 not found on PATH (needed to patch cordis.patch.yml)" >&2; exit 1; }
  echo "==> unmounting plugin from $PATCH_FILE"
  python3 "$PLUGIN_DIR/scripts/_patch_yml.py" "$PATCH_FILE" "$MARKER" remove
fi

if [[ -f "$PROFILE_DIR/package.json" ]]; then
  if command -v npm >/dev/null; then
    echo "==> removing npm file: dependency"
    (cd "$PROFILE_DIR" && npm uninstall --no-audit --no-fund memoplus4dsh) || true
  else
    echo "WARNING: npm not found on PATH; skipping 'npm uninstall'." >&2
    echo "         The node_modules symlink is still removed below, but a stale" >&2
    echo "         \"memoplus4dsh\": \"file:...\" entry may remain in" >&2
    echo "         $PROFILE_DIR/package.json — remove it by hand." >&2
  fi
fi
# npm uninstall is a no-op when the dependency is already gone; make sure the
# symlink itself is gone either way.
[[ -L "$PROFILE_DIR/node_modules/memoplus4dsh" ]] && rm "$PROFILE_DIR/node_modules/memoplus4dsh"

echo "==> done: memoplus4dsh removed from profile '$PROFILE'"
