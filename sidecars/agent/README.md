# Esse Agent Sidecar

This directory contains the Agent Sidecar distribution of Esse. “Agent Sidecar” is a technical packaging term; the installed application, window, MCP server, skills, and user-facing documentation all call the product **Esse**.

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

Local builds without signing environment variables emit an unsigned installer under `out/make/squirrel.windows/x64/Esse-Setup.exe`. Release builds normally must configure a trusted Authenticode certificate or cloud/HSM signer through the `@electron/windows-sign` environment variables and pass `npm run verify:signatures`. While the SignPath Foundation application is pending, `v0.3.0-alpha.2` and `v0.3.0` are explicit unsigned exceptions with Release warnings; later releases retain the signature gate.

The Squirrel application ID is `esse-agent-sidecar-app`, which is intentionally different from both the Codex Plugin data root and `%LOCALAPPDATA%\esse-agent-sidecar` runtime data root. Never change it back to `esse` or to a data-directory name.

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

Local builds may be unsigned for development. A GitHub Release build must configure `MACOS_SIGN_IDENTITY` plus the three `MACOS_NOTARY_API_*` values, then pass the strict bundle signature, Gatekeeper, notarization-ticket, icon, architecture, and packaged-app smoke checks. User data is stored in `~/Library/Application Support/esse-agent-sidecar`; API keys and the MCP pairing token use Electron `safeStorage` backed by macOS Keychain.

Use `npm start` only for development debugging. Do not commit `out/`, `.vite/`, `node_modules/`, local Provider settings, credentials, inputs, outputs, or QA captures.
