#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CODEX_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
NODE_BIN="${ESSE_NODE_BIN:-$CODEX_NODE}"

fail() {
  echo "Esse could not find a trusted Node.js runtime from Codex/ChatGPT." >&2
  echo "Update and reopen the desktop app, then run the Esse installer again." >&2
  exit 1
}

if [[ "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  fail
fi

if ! /usr/bin/codesign --verify --strict "$NODE_BIN" >/dev/null 2>&1; then
  echo "Esse refused to run an untrusted or modified Node.js executable: $NODE_BIN" >&2
  fail
fi

set +e
GATEKEEPER_OUTPUT="$(LC_ALL=C /usr/sbin/spctl --assess --type execute --verbose=4 "$NODE_BIN" 2>&1)"
GATEKEEPER_STATUS="$?"
set -e
if [[ "$GATEKEEPER_STATUS" -ne 0 && "$GATEKEEPER_OUTPUT" != *"the code is valid but does not seem to be an app"* ]]; then
  echo "Esse refused to run a Node.js executable rejected by Gatekeeper: $NODE_BIN" >&2
  echo "$GATEKEEPER_OUTPUT" >&2
  fail
fi

NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)" || fail
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt 20 ]]; then
  echo "Esse requires Node.js 20 or newer; found: ${NODE_MAJOR:-unknown}" >&2
  fail
fi

cd "$PLUGIN_ROOT"
exec "$NODE_BIN" "$PLUGIN_ROOT/mcp/server.cjs" "$@"
