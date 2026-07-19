#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="renoir1220/esse"
MARKETPLACE_NAME="esse-local"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="${ESSE_INSTALL_ROOT:-$HOME/Library/Application Support/esse/plugin}"
RELEASE_TAG="${ESSE_RELEASE_TAG:-}"
CODEX_BIN="${ESSE_CODEX_BIN:-codex}"
DOWNLOAD_ROOT=""
PREVIOUS_CATALOG=""
PREVIOUS_MARKETPLACE_ROOT=""
REGISTERED_STABLE=0
RESULT_EMITTED=0

cleanup() {
  if [[ -n "$DOWNLOAD_ROOT" && -d "$DOWNLOAD_ROOT" ]]; then
    rm -rf -- "$DOWNLOAD_ROOT"
  fi
}

emit_failure() {
  local code="$?"
  if [[ "$RESULT_EMITTED" -eq 0 && "$code" -ne 0 ]]; then
    printf 'ESSE_INSTALL_RESULT={"status":"failed","exitCode":%s}\n' "$code"
  fi
  cleanup
}
trap emit_failure EXIT

json_value() {
  local key="$1"
  local file="$2"
  sed -nE "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"[,]?$/\1/p" "$file" | head -n 1
}

normalize_path() {
  local path="$1"
  if [[ -d "$path" ]]; then
    (cd "$path" && pwd -P)
  else
    printf '%s\n' "$path"
  fi
}

codex_run() {
  "$CODEX_BIN" "$@"
}

restore_registration() {
  set +e
  if [[ -n "$PREVIOUS_CATALOG" && -f "$PREVIOUS_CATALOG" ]]; then
    mkdir -p "$(dirname "$CATALOG_PATH")"
    cp "$PREVIOUS_CATALOG" "$CATALOG_PATH"
  fi
  if [[ "$REGISTERED_STABLE" -eq 1 ]]; then
    codex_run plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1
  fi
  if [[ -n "$PREVIOUS_MARKETPLACE_ROOT" ]]; then
    codex_run plugin marketplace add "$PREVIOUS_MARKETPLACE_ROOT" >/dev/null 2>&1
  fi
  set -e
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install.sh supports macOS only. Use install.ps1 on Windows." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ASSET_KEY="macosArm64" ;;
  x86_64) ASSET_KEY="macosX64" ;;
  *) echo "Esse supports macOS arm64 and x64 only. Detected: $(uname -m)" >&2; exit 1 ;;
esac

PACKAGE_ROOT="$SCRIPT_DIR"
PACKAGE_BINARY="$PACKAGE_ROOT/plugins/esse/bin/esse"
if [[ ! -f "$PACKAGE_BINARY" ]]; then
  DOWNLOAD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/esse-install.XXXXXX")"
  if [[ -n "$RELEASE_TAG" ]]; then
    [[ "$RELEASE_TAG" == v* ]] || RELEASE_TAG="v$RELEASE_TAG"
    RELEASE_BASE="https://github.com/$REPOSITORY/releases/download/$RELEASE_TAG"
  else
    RELEASE_BASE="https://github.com/$REPOSITORY/releases/latest/download"
  fi
  METADATA_PATH="$DOWNLOAD_ROOT/latest.json"
  curl -fsSL "$RELEASE_BASE/latest.json" -o "$METADATA_PATH"
  ASSET_NAME="$(json_value "${ASSET_KEY}Asset" "$METADATA_PATH")"
  EXPECTED_HASH="$(json_value "${ASSET_KEY}Sha256" "$METADATA_PATH" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$ASSET_NAME" || ! "$EXPECTED_HASH" =~ ^[0-9a-f]{64}$ ]]; then
    echo "latest.json does not contain a valid asset for $ASSET_KEY." >&2
    exit 1
  fi
  ARCHIVE_PATH="$DOWNLOAD_ROOT/$ASSET_NAME"
  curl -fsSL "$RELEASE_BASE/$ASSET_NAME" -o "$ARCHIVE_PATH"
  ACTUAL_HASH="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print tolower($1)}')"
  if [[ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]]; then
    echo "SHA256 mismatch for $ASSET_NAME." >&2
    exit 1
  fi
  PACKAGE_ROOT="$DOWNLOAD_ROOT/package"
  mkdir -p "$PACKAGE_ROOT"
  /usr/bin/ditto -x -k "$ARCHIVE_PATH" "$PACKAGE_ROOT"
  PACKAGE_BINARY="$PACKAGE_ROOT/plugins/esse/bin/esse"
fi

PACKAGE_MARKETPLACE="$PACKAGE_ROOT/.agents/plugins/marketplace.json"
PLUGIN_SOURCE="$PACKAGE_ROOT/plugins/esse"
MANIFEST_PATH="$PLUGIN_SOURCE/.codex-plugin/plugin.json"
WIDGET_PATH="$PLUGIN_SOURCE/mcp/widget.html"
for required in "$PACKAGE_MARKETPLACE" "$PACKAGE_BINARY" "$MANIFEST_PATH" "$WIDGET_PATH"; do
  if [[ ! -f "$required" ]]; then
    echo "Release package is missing required file: $required" >&2
    exit 1
  fi
done

VERSION="$(json_value version "$MANIFEST_PATH")"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Release manifest has an invalid version: $VERSION" >&2
  exit 1
fi

chmod +x "$PACKAGE_BINARY"
SELF_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/esse-self-test.XXXXXX")"
if ! SELF_TEST_OUTPUT="$(cd "$PLUGIN_SOURCE" && ESSE_DATA_DIR="$SELF_TEST_ROOT/data" "$PACKAGE_BINARY" --self-test 2>&1)"; then
  rm -rf -- "$SELF_TEST_ROOT"
  echo "Esse runtime self-test failed: $SELF_TEST_OUTPUT" >&2
  exit 1
fi
rm -rf -- "$SELF_TEST_ROOT"
if [[ "$SELF_TEST_OUTPUT" != *'"status":"ok"'* && "$SELF_TEST_OUTPUT" != *'"status": "ok"'* ]]; then
  echo "Esse runtime self-test returned an invalid result: $SELF_TEST_OUTPUT" >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT/versions"
VERSION_ROOT="$INSTALL_ROOT/versions/$VERSION"
TARGET_PLUGIN="$VERSION_ROOT/plugins/esse"
if [[ ! -f "$TARGET_PLUGIN/bin/esse" ]]; then
  STAGING_ROOT="$(mktemp -d "$INSTALL_ROOT/.staging.XXXXXX")"
  mkdir -p "$STAGING_ROOT/plugins"
  cp -R "$PLUGIN_SOURCE" "$STAGING_ROOT/plugins/esse"
  chmod +x "$STAGING_ROOT/plugins/esse/bin/esse"
  if [[ -d "$VERSION_ROOT" ]]; then
    rm -rf -- "$VERSION_ROOT"
  fi
  mv "$STAGING_ROOT" "$VERSION_ROOT"
fi

CATALOG_PATH="$INSTALL_ROOT/.agents/plugins/marketplace.json"
mkdir -p "$(dirname "$CATALOG_PATH")"
if [[ -f "$CATALOG_PATH" ]]; then
  PREVIOUS_CATALOG="$(mktemp "${TMPDIR:-/tmp}/esse-catalog.XXXXXX")"
  cp "$CATALOG_PATH" "$PREVIOUS_CATALOG"
fi
CATALOG_TEMP="$CATALOG_PATH.tmp.$$"
sed "s#\./plugins/esse#./versions/$VERSION/plugins/esse#g" "$PACKAGE_MARKETPLACE" > "$CATALOG_TEMP"
mv "$CATALOG_TEMP" "$CATALOG_PATH"

if ! command -v "$CODEX_BIN" >/dev/null 2>&1 && [[ ! -x "$CODEX_BIN" ]]; then
  echo "Codex CLI was not found. Install or open the Codex desktop app first." >&2
  exit 1
fi

MARKETPLACE_LISTING="$(codex_run plugin marketplace list)"
EXISTING_ROOT="$(printf '%s\n' "$MARKETPLACE_LISTING" | awk '/^esse-local[[:space:]]/{sub(/^esse-local[[:space:]]+/, ""); print; exit}')"
STABLE_ROOT="$(normalize_path "$INSTALL_ROOT")"
if [[ -n "$EXISTING_ROOT" && "$(normalize_path "$EXISTING_ROOT")" != "$STABLE_ROOT" ]]; then
  PREVIOUS_MARKETPLACE_ROOT="$EXISTING_ROOT"
  codex_run plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null
  EXISTING_ROOT=""
fi
if [[ -z "$EXISTING_ROOT" ]]; then
  if ! codex_run plugin marketplace add "$STABLE_ROOT" >/dev/null; then
    restore_registration
    exit 1
  fi
  REGISTERED_STABLE=1
fi
if ! codex_run plugin add "esse@$MARKETPLACE_NAME" >/dev/null; then
  restore_registration
  exit 1
fi
PLUGIN_LISTING="$(codex_run plugin list)"
if ! printf '%s\n' "$PLUGIN_LISTING" | grep -Eq "esse@esse-local[[:space:]]+installed, enabled[[:space:]]+$VERSION"; then
  echo "Codex did not report esse@esse-local as installed and enabled at version $VERSION." >&2
  restore_registration
  exit 1
fi

INSTALLED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
cat > "$INSTALL_ROOT/install-receipt.json" <<EOF
{
  "schemaVersion": 1,
  "repository": "https://github.com/$REPOSITORY",
  "version": "$VERSION",
  "installedAt": "$INSTALLED_AT",
  "pluginPath": "$TARGET_PLUGIN"
}
EOF

echo "Esse $VERSION installed and enabled."
echo "Restart the Codex/ChatGPT desktop app, start a new task, and say: 打开 Esse 设置"
echo "Enter the Provider API Key only inside the Esse settings UI, never in chat."
printf 'ESSE_INSTALL_RESULT={"status":"installed","version":"%s","marketplace":"%s","installRoot":"%s","restartRequired":true}\n' "$VERSION" "$MARKETPLACE_NAME" "$INSTALL_ROOT"
RESULT_EMITTED=1
exit 0
