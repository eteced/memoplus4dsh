#!/usr/bin/env bash
# install.sh — install the memoplus4dsh plugin into a dsh profile.
#
# What it does (all idempotent, fully reversed by uninstall.sh):
#   1. Builds the plugin (tsc -> lib/) so the installed code is current.
#   2. Initializes the profile directory exactly like dsh's own initProfile
#      (package.json with the template bundle list, cordis.patch.yml,
#      pnpm-workspace.yaml) when it does not exist yet.
#   3. Installs the plugin into the profile with `npm install <plugin dir>`,
#      which records a "file:" dependency and symlinks the checkout into the
#      profile's node_modules — local edits + rebuild take effect immediately.
#      (npm does not install a linked package's own dependencies, so the
#      plugin keeps using the dsh installation's shared cordis instance.)
#   4. Inserts a managed block into the profile's cordis.patch.yml mounting
#      the plugin: `- insert: [{ id: memoplus4dsh, name: 'memoplus4dsh', ... }]`.
#
# Usage:
#   install.sh [--profile <name>] [--dsh-home <path>]
# Defaults: --profile web, dsh home = $DSH_HOME or ~/.dsh.
set -euo pipefail

PROFILE="web"
DSH_HOME_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --dsh-home) DSH_HOME_ARG="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME_RESOLVED="${DSH_HOME_ARG:-${DSH_HOME:-$HOME/.dsh}}"
PROFILE_DIR="$DSH_HOME_RESOLVED/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
MARKER="memoplus4dsh"

# Node/npm must be on PATH; set NODE_BIN to prepend a specific bin directory.
if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN/npm" ]]; then export PATH="$NODE_BIN:$PATH"; fi
command -v npm >/dev/null || { echo "install.sh: npm not found on PATH (or set NODE_BIN)" >&2; exit 1; }
command -v python3 >/dev/null || { echo "install.sh: python3 not found on PATH (needed to patch cordis.patch.yml)" >&2; exit 1; }

echo "==> building plugin in $PLUGIN_DIR"
# Fresh clones have no node_modules: npm run build needs the devDependency
# typescript. Install dev deps once (npm ci when the lockfile is present).
if [[ ! -x "$PLUGIN_DIR/node_modules/.bin/tsc" ]]; then
  echo "==> installing plugin dev dependencies (first run only)"
  if [[ -f "$PLUGIN_DIR/package-lock.json" ]]; then
    (cd "$PLUGIN_DIR" && npm ci --no-audit --no-fund)
  else
    (cd "$PLUGIN_DIR" && npm install --no-audit --no-fund)
  fi
fi
(cd "$PLUGIN_DIR" && npm run build)

# Mirror of dsh's initProfile (packages/boot/app-boot/src/profile.ts): known
# profile names get their shipped bundle template, anything else gets the
# default base-only list. Existing files are never touched.
if [[ ! -f "$PROFILE_DIR/package.json" ]]; then
  echo "==> initializing profile '$PROFILE' at $PROFILE_DIR"
  mkdir -p "$PROFILE_DIR"
  case "$PROFILE" in
    web)      BUNDLES='"@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"'; RELOAD="live" ;;
    acp)      BUNDLES='"@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"'; RELOAD="startup" ;;
    headless) BUNDLES='"@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"'; RELOAD="startup" ;;
    sdk)      BUNDLES='"@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"'; RELOAD="startup" ;;
    sdk-minimal) BUNDLES='"@deepseek-ai/dsh-sdk-minimal"'; RELOAD="startup" ;;
    *)        BUNDLES='"@deepseek-ai/dsh-base"'; RELOAD="live" ;;
  esac
  cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [$BUNDLES],
      "patchReload": "$RELOAD"
    }
  }
}
EOF
fi
[[ -f "$PATCH_FILE" ]] || printf '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n' > "$PATCH_FILE"
[[ -f "$PROFILE_DIR/pnpm-workspace.yaml" ]] || printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$PROFILE_DIR/pnpm-workspace.yaml"

echo "==> linking plugin into profile (npm install file: dep)"
(cd "$PROFILE_DIR" && npm install --no-audit --no-fund "$PLUGIN_DIR")

echo "==> mounting plugin in $PATCH_FILE"
# macOS/BSD mktemp requires the X's at the end of the template (no suffix).
BLOCK_FILE="$(mktemp "${TMPDIR:-/tmp}/memoplus4dsh-patch-block.XXXXXX")"
trap 'rm -f "$BLOCK_FILE"' EXIT
cat > "$BLOCK_FILE" <<'EOF'
- insert:
    - id: memoplus4dsh
      name: 'memoplus4dsh'
      config:
        extraction: turn_end
        injectTopK: 8
EOF
python3 "$PLUGIN_DIR/scripts/_patch_yml.py" "$PATCH_FILE" "$MARKER" add "$BLOCK_FILE"

echo "==> done: memoplus4dsh installed into profile '$PROFILE' ($PROFILE_DIR)"
