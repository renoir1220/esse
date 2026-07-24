# Esse Agent Sidecar

This directory contains the open-source Agent Sidecar distribution, installed as **Esse Community**. The MCP server and skills keep the shorter Esse protocol name for compatibility.

It runs a local Electron workspace and authenticated loopback HTTP MCP for WorkBuddy and other compatible Agents. It has no hosted Esse backend. Provider profiles are stored locally, API keys are protected by the operating system, and the release contains built-in Tuzi configuration presets but no API key.

## Shared implementation

Windows and macOS use the same TypeScript/Electron core for Provider settings, secure credentials, batches, image storage, the UI, and loopback MCP. `src/platform.ts`, native packaging, signing, window chrome, and application lifecycle contain the operating-system adaptations; do not fork the product core into a macOS copy.

## Development on Windows

```powershell
npm install
npm run typecheck
npm test
npm run make
npm run verify:icons:windows
```

Local builds without signing environment variables emit an unsigned installer under `out/make/squirrel.windows/x64/Esse-Community-Setup.exe`. Release builds normally must configure a trusted Authenticode certificate or cloud/HSM signer through the `@electron/windows-sign` environment variables and pass `npm run verify:signatures`. While the SignPath Foundation application is pending, `v0.3.0-alpha.2` and `v0.3.0` are explicit unsigned exceptions with Release warnings; later releases retain the signature gate.

The Squirrel application ID is `esse-community-app`, which is intentionally different from both the Codex Plugin data root and `%LOCALAPPDATA%\esse-community` runtime data root. It also differs from the commercial product, so both editions can be installed together.

## Development on macOS

Run on the target architecture (`arm64` or `x64`):

```bash
npm install
npm run typecheck
npm test
arch="$(uname -m | sed 's/x86_64/x64/')"
npm run "make:macos:$arch"
bash scripts/verify-macos-bundle.sh "$arch"
```

Builds without Developer ID credentials are fully ad-hoc signed after Electron fuses and bundle metadata are finalized, then must pass strict structural signature, icon, architecture, and packaged-app smoke checks. This prevents a corrupted temporary fuse signature from reaching users, but it is not publisher identity or Apple notarization and cannot provide a stable identity across versions. A trusted GitHub Release build must configure `MACOS_SIGN_IDENTITY` plus the three `MACOS_NOTARY_API_*` values and additionally pass Gatekeeper and notarization-ticket checks. User data is stored in `~/Library/Application Support/esse-community`; API keys and the MCP pairing token use Electron `safeStorage` backed by macOS Keychain.

Use `npm start` only for development debugging. Do not commit `out/`, `.vite/`, `node_modules/`, local Provider settings, credentials, inputs, outputs, or QA captures.
