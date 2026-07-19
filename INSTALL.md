# Install Esse with Codex

This file is the installation contract for an Agent given only this repository URL.

## Required outcome

Install the latest stable Esse GitHub Release into the current user's profile, register the `esse-local` marketplace, install and enable `esse`, verify the result, then guide the user through restart and UI-only Provider setup.

Do not ask the user to download an archive manually. Do not ask for a Provider API key in chat.

## Agent procedure

1. Confirm the host is Windows x64, macOS arm64, or macOS x64. Stop with a clear unsupported-platform message otherwise.
2. Read the installer before executing it. The installer may request network access to `github.com` and write access only to the user's Esse application-data directory and Codex plugin configuration.
3. Run the repository installer. It downloads `latest.json` and the matching versioned archive from the latest GitHub Release, verifies SHA256, and performs an idempotent user-scoped installation.
4. Treat an `ESSE_INSTALL_RESULT` line with `status: "installed"` as the structured success marker. Also verify that `codex plugin marketplace list` contains `esse-local` and `codex plugin list` contains an installed, enabled `esse@esse-local` at the reported version.
5. Do not try to open Esse in the same task. Newly installed skills and MCP tools load after the desktop app restarts and a new task begins.

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

## Required handoff

After verification, report the installed version and say:

1. Completely restart the Codex/ChatGPT desktop app.
2. Start a new task.
3. Say `打开 Esse 设置` or type `@esse` and ask it to open settings.
4. In the Esse UI, add a Provider, paste the API Key there, test the connection, choose a default image model, and save.

Explicitly remind the user that the API Key belongs only in the Esse settings UI and should never be pasted into chat.

## Update behavior

Running the same installation request again installs the latest release. Versions are stored separately under the user-scoped Esse plugin directory, and the fixed local marketplace is switched only after the new runtime passes its self-test. If plugin registration fails, the installer restores the previous marketplace selection.
