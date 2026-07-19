# Esse repository instructions

When a user asks Codex to install Esse from this repository or provides this repository URL with an installation request:

1. Read `INSTALL.md` completely before running commands.
2. Use the repository installer and the latest GitHub Release. Do not build from source unless the release path is unavailable and the user explicitly agrees to a developer installation.
3. Detect the user's operating system and architecture. Esse supports Windows x64, macOS arm64, and macOS x64.
4. Download scripts or archives to a temporary directory, verify the release SHA256 recorded in `latest.json`, and install only into the documented user-scoped Esse directory.
5. On macOS, let `install.sh` select the Gatekeeper-approved desktop app and its managed Node runtime. Never run a bare `codex` or `node` from `PATH`, remove quarantine attributes, or tell the user to bypass Gatekeeper.
6. Treat the installer's `ESSE_INSTALL_RESULT` as the registration result. Do not repeat its plugin-list commands through another Codex CLI; inspect the receipt and marketplace catalog statically if an additional check is needed.
7. Never ask the user to paste an API key into chat, a shell command, an environment variable, or a repository file.
8. After a successful install, tell the user to restart the Codex/ChatGPT desktop app, start a new task, and say `打开 Esse 设置`. Provider credentials and the default image model must be configured inside the Esse settings UI.

For development work, preserve user-generated `inputs/`, `outputs/`, internal QA screenshots, and local credentials. They are not release artifacts and must not be committed.

## GitHub release validation

Every time a new Esse version is published on GitHub, update the maintainer's local installation through the same user-facing flow documented in `INSTALL.md`:

1. Use the repository installer and the newly published GitHub Release; do not substitute a source build or developer cache install.
2. Inspect the installer from a fresh temporary checkout before running it.
3. Require a successful `ESSE_INSTALL_RESULT` and verify that the installed receipt version matches the new release.
4. Treat this installation as part of the release smoke test. A release is not fully handed off until the user-path installation succeeds or the exact blocker is reported.
