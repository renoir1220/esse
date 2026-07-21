#!/bin/bash
set -euo pipefail

arch="${1:-}"
require_signed="${2:-}"
case "$arch" in
  arm64) expected_arch="arm64" ;;
  x64) expected_arch="x86_64" ;;
  *) echo "Usage: verify-macos-bundle.sh <arm64|x64> [--require-signed]" >&2; exit 2 ;;
esac

sidecar_root="$(cd "$(dirname "$0")/.." && pwd)"
app="$sidecar_root/out/Esse-darwin-$arch/Esse.app"
plist="$app/Contents/Info.plist"
test -d "$app"
test -f "$plist"

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
icon_file="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$plist")"
test "$bundle_id" = "com.renoir.esse.agent-sidecar"
test -n "$icon_file"
test -f "$app/Contents/Resources/$icon_file"
test -f "$app/Contents/Resources/esse.png"
cmp "$sidecar_root/assets/esse.icns" "$app/Contents/Resources/$icon_file"
cmp "$sidecar_root/assets/esse.png" "$app/Contents/Resources/esse.png"
/usr/bin/file "$app/Contents/MacOS/$executable" | /usr/bin/grep -q "$expected_arch"

iconset="$(mktemp -d)/esse.iconset"
/usr/bin/iconutil --convert iconset --output "$iconset" "$app/Contents/Resources/$icon_file"
test -s "$iconset/icon_16x16.png"
test -s "$iconset/icon_128x128@2x.png"
test -s "$iconset/icon_512x512@2x.png"

if test "$require_signed" = "--require-signed"; then
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
  /usr/sbin/spctl --assess --type execute --verbose=2 "$app"
  /usr/bin/xcrun stapler validate "$app"
fi

smoke_root="$(mktemp -d)"
smoke_log="$smoke_root/smoke.log"
ESSE_QA_USER_DATA_PATH="$smoke_root/user-data" ESSE_SMOKE_TEST=1 "$app/Contents/MacOS/$executable" >"$smoke_log" 2>&1 &
smoke_pid=$!
for _ in $(seq 1 45); do
  if ! kill -0 "$smoke_pid" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "$smoke_pid" 2>/dev/null; then
  kill "$smoke_pid" 2>/dev/null || true
  wait "$smoke_pid" 2>/dev/null || true
  cat "$smoke_log" >&2
  echo "Packaged macOS app smoke test timed out." >&2
  exit 1
fi
wait "$smoke_pid"
/usr/bin/grep -q 'ESSE_SMOKE_RESULT={"ok":true' "$smoke_log"

printf '{"status":"ok","platform":"macos","arch":"%s","bundleId":"%s","icon":"Esse","smoke":"ok"}\n' "$arch" "$bundle_id"
