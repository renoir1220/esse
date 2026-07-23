# Esse Community

**Language: [简体中文](README.md) | English**

Esse Community is the open-source community edition of Esse, a local image workspace directed by an Agent. The UI, installers, and settings entry points use the full name “Esse Community”; in ordinary use, users still only need to say “use Esse to generate images.”

Provider settings, API keys, batch records, and original images stay on the local computer. Selected references leave the computer only for an actual generation or edit request to the configured Provider or the current Agent image capability. No API key is bundled, and no hosted Esse Community backend is required.

## Two distributions

- **Codex Plugin** for the Codex/ChatGPT desktop app on Windows x64, macOS arm64, and macOS x64.
- **Agent Sidecar** for WorkBuddy and other Agents that support a local HTTP MCP. It supports Windows x64, macOS arm64, and macOS x64 with the complete Esse workspace and background task execution.

These are technical distributions of Esse Community, not separate user-facing brands. Most users install only the one that matches their Agent.

## Install the Codex Plugin

Send this to Codex:

> Install this plugin: https://github.com/renoir1220/esse

Codex should read [`INSTALL.md`](INSTALL.md), detect the platform, download the Release, verify SHA256, install it in the user profile, and register the plugin. After restarting the desktop app and opening a new task, say “Open Esse Community settings,” then configure the Provider, API key, and default model inside Esse Community. Never paste an API key into chat.

You can also download the matching Plugin ZIP from [GitHub Releases](https://github.com/renoir1220/esse/releases), extract it, and run `install.ps1` or `install.sh`.

## Install for WorkBuddy and other Agents

Download the matching `esse-community-windows-x64-*.exe` or `esse-community-macos-*-*.dmg` from [GitHub Releases](https://github.com/renoir1220/esse/releases), verify it against `sidecar-latest.json` or `checksums.txt`, and open Esse Community after installation. In settings:

1. Select a built-in Tuzi Provider preset or add an OpenAI-compatible Provider.
2. Enter the API key inside Esse Community, test the connection, and save a default model.
3. Copy the MCP configuration into the Agent's user-level HTTP MCP settings.

Then simply tell the Agent to “use Esse to generate images.” Once durable background work is accepted by Esse Community, the Agent should return control immediately. It should not copy outputs back into the chat workspace or narrate prices and progress unless the user explicitly asks.

## Local data

- Codex Plugin: `%LOCALAPPDATA%\esse` on Windows; `~/Library/Application Support/esse` on macOS
- Esse Community: `%LOCALAPPDATA%\esse-community` on Windows; `~/Library/Application Support/esse-community` on macOS

The directories are intentionally isolated, and the Sidecar installer never owns a directory used for data. Repository migration does not move, overwrite, or delete legacy `esse-desktop` data. Windows API keys are protected with current-user DPAPI; macOS uses Keychain.

## Code signing

Agent Sidecar signing status follows the public [Code signing policy](CODE_SIGNING.md). Signing credentials are not currently a release prerequisite. When credentials are absent, CI explicitly verifies that artifacts are unsigned and the GitHub Release discloses that status. Windows may show unknown-publisher or SmartScreen warnings, and macOS Gatekeeper may reject an unsigned app. A verified checksum is not a publisher signature, and users must never be asked to disable platform security.

## Repository layout

```text
plugins/codex/       Codex Plugin
sidecars/agent/      Sidecar for local Agents
apps/standalone/     Placeholder for a future standalone app
docs/                Roadmap, contracts, and development documentation
```

A shared Core is intentionally deferred. Each distribution must build and run independently; meaningful behavior ports are recorded in [`SYNC.md`](SYNC.md).

## Development

Codex Plugin:

```bash
cd plugins/codex
npm install
npm run check
```

Agent Sidecar (one shared core for Windows x64 and macOS arm64/x64):

```bash
cd sidecars/agent
npm install
npm run typecheck
npm test
npm run make
```

Licensed under MIT; see [`LICENSE`](LICENSE).
