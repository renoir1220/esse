# Install Esse

This file is the installation contract for an Agent given only this repository URL. `Codex Plugin` and `Agent Sidecar` below are technical distribution names; after installation the product is always called Esse.

## Required outcome

For Codex/ChatGPT, install the Plugin from the requested Esse GitHub Release into the current user's profile, register the `esse-local` marketplace, install and enable `esse`, verify the result, then guide the user through restart and UI-only default model setup.

Do not ask the user to download an archive manually. Do not ask for a Provider API key in chat. Never disable or bypass Gatekeeper.

## Agent procedure

1. Confirm the host is Windows x64, macOS arm64, or macOS x64. Stop with a clear unsupported-platform message otherwise.
2. Read the installer before executing it. The installer may request network access to `github.com` and write access only to the user's Esse application-data directory and Codex plugin configuration.
3. Run the repository installer. It downloads `latest.json` and the matching versioned archive from the latest GitHub Release, verifies SHA256, and performs an idempotent user-scoped installation.
4. Treat an `ESSE_INSTALL_RESULT` line with `status: "installed"` as the structured success marker. The installer performs plugin registration and verification with its selected Codex executable; do not repeat those commands through a bare `codex` from `PATH`.
5. Do not try to open Esse in the same task. Newly installed skills and MCP tools load after the desktop app restarts and a new task begins.

This procedure installs the Codex Plugin. For WorkBuddy or another Agent that consumes a local HTTP MCP, use the Windows Agent Sidecar procedure below instead; do not install both merely to offer a choice.

### Windows

Prefer a shallow temporary clone so the script can be inspected before execution:

```powershell
$target = Join-Path ([IO.Path]::GetTempPath()) ("esse-install-" + [guid]::NewGuid().ToString("N"))
git clone --depth 1 https://github.com/renoir1220/esse.git $target
Get-Content -Raw -Encoding UTF8 (Join-Path $target "install.ps1")
& (Join-Path $target "install.ps1")
```

If `git` is unavailable, download `https://raw.githubusercontent.com/renoir1220/esse/main/install.ps1` to a temporary file, inspect it, and run that file with PowerShell.

### macOS

Prefer a shallow temporary clone so the script can be inspected before execution:

```bash
target="$(mktemp -d)/esse"
git clone --depth 1 https://github.com/renoir1220/esse.git "$target"
sed -n '1,320p' "$target/install.sh"
bash "$target/install.sh"
```

If `git` is unavailable, download `https://raw.githubusercontent.com/renoir1220/esse/main/install.sh` to a temporary file, inspect it, and run it with `bash`. Do not pipe a remote script directly into a shell.

The macOS package does not contain an Esse-built Mach-O executable. Its small Bash launcher runs the JS MCP with the signed Node.js runtime managed by Codex/ChatGPT, so the user does not need to install Node or obtain an Apple Developer certificate. Before changing plugin registration, the installer:

- rejects legacy macOS packages that contain the old standalone Esse executable;
- verifies and self-tests the managed Node.js runtime;
- selects only a Gatekeeper-approved Codex/ChatGPT desktop app;
- refuses to fall back to an arbitrary `codex` command from `PATH`.

If one of these checks fails, stop and report the installer message. Do not run `xattr -d`, use `spctl --master-disable`, or instruct the user to choose an “Open Anyway” override. Updating and reopening the official desktop app is the supported recovery path.

## Required handoff

After verification, report the installed version and say:

1. Completely restart the Codex/ChatGPT desktop app.
2. Start a new task.
3. Say `打开 Esse 设置` or type `@esse` and ask it to open settings.
4. In the Esse UI, choose `Codex 生成` as the default model, or add a Provider, paste the API Key there, test the connection, choose one of its image models, and save.

Explicitly remind the user that the API Key belongs only in the Esse settings UI and should never be pasted into chat.

## Windows Agent Sidecar procedure

The Agent Sidecar is currently released only for Windows x64. Download these two assets from the same requested GitHub Release:

- `sidecar-latest.json`
- the `esse-agent-sidecar-windows-x64-v*.exe` named by that metadata file

Verify the installer SHA256 against `windowsX64Sha256` before running it. `v0.3.0` is an explicitly unsigned release while SignPath Foundation approval is pending, so report the publisher limitation honestly; never disable Windows security controls. The installed application and window are named Esse.

After installation, the user opens Esse and completes setup inside its settings page:

1. Choose a built-in Tuzi preset or add an OpenAI-compatible Provider.
2. Paste the API Key inside Esse, test it, and save a default image model.
3. Copy the MCP server configuration from Esse into the Agent's user-level HTTP MCP settings.
4. Start a new Agent task and say `用 Esse 生成图片`.

Never request the API Key in chat or put it in an Agent configuration file. The MCP configuration contains only a local loopback endpoint and per-install pairing token. Once Esse accepts Provider work in the background, the Agent should return control immediately and should not poll or copy output back unless the user explicitly asks.

## Update behavior

Running the same installation request again installs the latest release. Versions are stored separately under the user-scoped Esse plugin directory, and the fixed local marketplace is switched only after the new runtime passes its self-test. If plugin registration fails, the installer restores the previous marketplace selection. macOS runtime or desktop-app trust failures happen before the marketplace is changed.
