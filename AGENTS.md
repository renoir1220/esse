# Esse repository instructions

When a user asks Codex to install Esse from this repository or provides this repository URL with an installation request:

1. Read `INSTALL.md` completely before running commands.
2. For the Codex Plugin, use the repository installer and the requested GitHub Release. For the Agent Sidecar, use its published platform installer. Do not build from source unless the release path is unavailable and the user explicitly agrees to a developer installation.
3. Detect the user's operating system and architecture. The Codex Plugin and Agent Sidecar support Windows x64, macOS arm64, and macOS x64.
4. Download scripts or artifacts to a temporary directory, verify the release SHA256 recorded in `latest.json` for the Plugin or `sidecar-latest.json` for the Agent Sidecar, and install only into the documented user-scoped Esse directory.
5. On macOS, let `install.sh` select the Gatekeeper-approved desktop app and its managed Node runtime. Never run a bare `codex` or `node` from `PATH`, remove quarantine attributes, or tell the user to bypass Gatekeeper.
6. Treat the installer's `ESSE_INSTALL_RESULT` as the registration result. Do not repeat its plugin-list commands through another Codex CLI; inspect the receipt and marketplace catalog statically if an additional check is needed.
7. Never ask the user to paste an API key into chat, a shell command, an environment variable, or a repository file.
8. After a successful install, tell the user to restart the Codex/ChatGPT desktop app, start a new task, and say `打开 Esse 设置`. Provider credentials and the default image model must be configured inside the Esse settings UI.

For development work, preserve user-generated `inputs/`, `outputs/`, internal QA screenshots, and local credentials. They are not release artifacts and must not be committed.

## Repository architecture

- `plugins/codex` contains the Codex Plugin.
- `sidecars/agent` contains the Agent Sidecar for WorkBuddy and other local HTTP MCP Agents.
- `apps/standalone` is only a placeholder for a future true standalone application.
- Do not merge the old private `esse-desktop` Git history, server, billing, account, balance, channel-management, data, credentials, inputs, outputs, or QA artifacts into this repository.
- Do not introduce a shared Core or a runtime dependency between the Plugin and Agent Sidecar yet. Port behavior semantically and record meaningful parity changes in `SYNC.md`.
- Community releases use one tag and one GitHub Release with grouped Plugin and Agent Sidecar assets. A private downstream may publish only its Agent Sidecar on an independent version line when `sidecars/agent/product.json` declares `releaseVersionPolicy: "independent-sidecar"`; it continues to inherit the separately released Community Plugin. Do not create permanent product branches.

## Community-first downstream workflow

This public repository is the source of truth for shared, MIT-licensed Esse behavior. A checkout containing `PRIVATE-DOWNSTREAM.md` is a private downstream, not an independent implementation of shared features.

1. Classify a requested change before editing. Task scheduling, MCP contracts, Provider adapters, reference handling, shared UI behavior, security fixes, and cross-edition tests are Community changes.
2. Implement and validate Community changes in `renoir1220/esse` first, publish them through a Community pull request, and merge that PR before updating a private downstream. Do not patch the downstream first or maintain a duplicate downstream-only commit for shared behavior.
3. After the Community PR merges, update the downstream by fetching and merging `upstream/main`. Resolve conflicts only in documented private overlays; do not manually copy or cherry-pick the shared implementation unless an exceptional merge blocker is documented in the PR.
4. Direct downstream changes are limited to private onboarding, managed connections, product configuration, private release automation, and paid-service code described by `PRIVATE-DOWNSTREAM.md`.
5. If the Community checkout, `upstream` remote, permission, or configuration is missing, repair or request that environment instead of bypassing the Community-first path.

## Product naming

The product is always called **Esse** in every user-facing surface, regardless of how it is packaged or hosted.

1. Users must only need to say phrases such as `用 Esse 生成图片`; never require or encourage phrases such as `用 Esse Sidecar 生成图片`, `用 Esse Desktop 生成图片`, or other packaging-specific names.
2. Electron window titles, installed application names, MCP titles, skills, prompts, notices, documentation for end users, and Agent conversation guidance must call the product `Esse`.
3. Terms such as `Codex Plugin`, `Agent Sidecar`, and `Standalone App` may be used only where developers or installers need to distinguish distribution forms. They are not separate user-facing product names.
4. Assume a customer installs one distribution form. Do not add cross-edition selection language or make the user identify which Esse form is handling a task.

## GitHub release validation

Every time a new Esse version is published on GitHub, update the maintainer's local installation through the same user-facing flow documented in `INSTALL.md`:

1. Use the repository installer and the newly published GitHub Release; do not substitute a source build or developer cache install.
2. Inspect the installer from a fresh temporary checkout before running it.
3. Require a successful `ESSE_INSTALL_RESULT` and verify that the installed receipt version matches the new release.
4. Treat this installation as part of the release smoke test. A release is not fully handed off until the user-path installation succeeds or the exact blocker is reported.

## GitHub release notes

Write every GitHub Release note as a version-specific, bilingual changelog:

1. Put Simplified Chinese first and English second. Keep both sections semantically aligned.
2. Lead directly with the changes in this version. Do not include a general product introduction, platform overview, or routine installation instructions; those belong in `README.md`, `README.en.md`, and `INSTALL.md`.
3. Emphasize user-visible additions, improvements, and fixes. State the practical impact instead of merely listing changed files or internal implementation details.
4. Derive the content from the previous-tag comparison and merged pull requests. Do not claim changes that cannot be verified from the release diff.
5. Omit release-preparation noise such as version bumps, packaging-only commits, and duplicated auto-generated changelogs unless they materially affect users.
6. End each language section with the matching full-changelog comparison link. Include pull request links only when they add useful detail.
