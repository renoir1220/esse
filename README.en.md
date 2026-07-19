# Esse

**Language: [简体中文](README.md) | English**

Esse is a local image workspace for Codex and ChatGPT Work. It runs through a local `stdio MCP`; no hosted Esse service, HTTPS tunnel, `.env`, or `npm start` process is required.

Only image generation and editing requests send the selected reference images to the current Agent's image model or to a Provider chosen by the user. Provider keys, task records, input paths, and output images remain on the local computer.

## Install with Codex

Send this sentence to Codex:

> Install this plugin: https://github.com/renoir1220/esse

Codex should read [`INSTALL.md`](INSTALL.md) first, then detect the platform, download the matching Release, verify its SHA256 checksum, install it into the user profile, register the plugin, and verify the installation. The user does not need to select an archive or extraction directory manually.

After installation, Codex will ask you to restart the desktop app. Start a new task after restarting and say “Open Esse settings.” You can choose “Codex generation” directly, or configure a Provider, API key, and default model. Do not paste API keys into the chat.

Supported platforms:

- Windows x64
- macOS Apple Silicon
- macOS Intel

The macOS Release no longer contains an Esse-built Mach-O executable. A reviewable Bash launcher uses the signed Node.js runtime managed by Codex/ChatGPT, so users do not need to install Node or obtain an Apple Developer identity. The installer invokes only the desktop app's Gatekeeper-approved Codex executable, never an arbitrary command with the same name from `PATH`, and never asks users to bypass macOS security.

## Manual installation

To install without Codex, download the ZIP for your platform from [GitHub Releases](https://github.com/renoir1220/esse/releases/latest), extract it, and run:

Windows:

```powershell
.\install.ps1
```

macOS:

```bash
bash ./install.sh
```

The installer is idempotent. Running it again installs or switches to that version. Running the installer directly from this repository downloads and verifies the latest stable Release.

## Local data

- Windows: `%LOCALAPPDATA%\esse`
- macOS: `~/Library/Application Support/esse`

Windows keys are encrypted with current-user DPAPI. macOS keys are stored in the system Keychain. Generated images are written to `esse Output/<batch-id>/` under the source folder by default and never overwrite the originals.

The plugin runtime is installed in:

- Windows: `%LOCALAPPDATA%\esse\plugin`
- macOS: `~/Library/Application Support/esse/plugin`

## Development

The plugin source is under [`plugins/esse`](plugins/esse).

```bash
cd plugins/esse
npm install
npm run check
```

The Release workflow builds a self-contained Windows runtime and two safe macOS launcher archives on native runners, then creates the Release metadata:

```bash
npm run package:releases
```

`npm run preview` is only for visual browser testing during development; it is not part of the plugin runtime architecture.
