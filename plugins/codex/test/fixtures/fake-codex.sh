#!/bin/bash
set -euo pipefail

case "$*" in
  "plugin marketplace list")
    exit 0
    ;;
  "plugin marketplace add "*|"plugin marketplace remove "*|"plugin add "*)
    exit 0
    ;;
  "plugin list")
    printf 'esse@esse-local installed, enabled %s\n' "${ESSE_FAKE_PLUGIN_VERSION:?}"
    ;;
  *)
    echo "Unexpected fake Codex arguments: $*" >&2
    exit 2
    ;;
esac
