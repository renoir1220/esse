# Esse

**Language: [简体中文](README.md) | English**

Esse is a local image workspace directed by an Agent. Users only need to say “use Esse to generate images.” Whether the installed distribution is the Codex Plugin or the local client for WorkBuddy and similar Agents, the product is always called Esse.

Provider settings, API keys, batch records, and original images stay on the local computer. Selected references leave the computer only for an actual generation or edit request to the configured Provider or the current Agent image capability. No API key is bundled, and no hosted Esse backend is required.

## Two distributions

- **Codex Plugin** for the Codex/ChatGPT desktop app on Windows x64, macOS arm64, and macOS x64.
- **Agent Sidecar** for WorkBuddy and other Agents that support a local HTTP MCP. The current release is a Windows x64 installer with the complete Esse workspace and background task execution.

These are technical distributions of one product, not separate user-facing brands. Most users install only the one that matches their Agent.

## Install the Codex Plugin

Send this to Codex:

> Install this plugin: https://github.com/renoir1220/esse

Codex should read [`INSTALL.md`](INSTALL.md), detect the platform, download the Release, verify SHA256, install it in the user profile, and register the plugin. After restarting the desktop app and opening a new task, say “Open Esse settings,” then configure the Provider, API key, and default model inside Esse. Never paste an API key into chat.

You can also download the matching Plugin ZIP from [GitHub Releases](https://github.com/renoir1220/esse/releases), extract it, and run `install.ps1` or `install.sh`.

## Install for WorkBuddy and other Agents

Download `esse-agent-sidecar-windows-x64-*.exe` from [GitHub Releases](https://github.com/renoir1220/esse/releases), verify it against `sidecar-latest.json` or `checksums.txt`, and open Esse after installation. In Esse settings:

1. Select a built-in Tuzi Provider preset or add an OpenAI-compatible Provider.
2. Enter the API key inside Esse, test the connection, and save a default model.
3. Copy the MCP configuration into the Agent's user-level HTTP MCP settings.

Then simply tell the Agent to “use Esse to generate images.” Once durable background work is accepted, the Agent should return control immediately. It should not copy outputs back into the chat workspace or narrate prices and progress unless the user explicitly asks.

## Local data

- Codex Plugin: `%LOCALAPPDATA%\esse` on Windows; `~/Library/Application Support/esse` on macOS
- Agent Sidecar: `%LOCALAPPDATA%\esse-agent-sidecar` on Windows

The directories are intentionally isolated. Repository migration does not move, overwrite, or delete legacy `esse-desktop` data. Windows API keys are protected with current-user DPAPI; the macOS Plugin uses Keychain.

## Code signing

Official Windows Agent Sidecar artifacts follow the public [Code signing policy](CODE_SIGNING.md). The release workflow verifies the Authenticode signature of both the application and installer, and refuses to publish builds that do not pass verification.

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

Agent Sidecar (currently released for Windows x64 only):

```bash
cd sidecars/agent
npm install
npm run typecheck
npm test
npm run make
```

Licensed under MIT; see [`LICENSE`](LICENSE).
