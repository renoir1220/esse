#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "$0")" && pwd)"
MARKETPLACE_FILE="$PACKAGE_ROOT/.agents/plugins/marketplace.json"
PLUGIN_BINARY="$PACKAGE_ROOT/plugins/esse/bin/esse"

if [[ ! -f "$MARKETPLACE_FILE" ]]; then
  echo "Missing marketplace manifest: $MARKETPLACE_FILE" >&2
  exit 1
fi
if [[ ! -f "$PLUGIN_BINARY" ]]; then
  echo "This is not a macOS esse package." >&2
  exit 1
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI was not found. Install or open the ChatGPT desktop app first." >&2
  exit 1
fi

chmod +x "$PLUGIN_BINARY"
if ! codex plugin marketplace list | grep -Fq "$PACKAGE_ROOT"; then
  codex plugin marketplace add "$PACKAGE_ROOT"
fi
codex plugin add "esse@esse-local"

echo "esse installed locally."
echo "Restart the ChatGPT desktop app, start a new chat, and say: 打开 esse"
