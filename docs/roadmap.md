# Esse roadmap

## Current architecture

The public repository has one `main` branch and two independently buildable distributions:

```text
plugins/codex/       Codex Plugin
sidecars/agent/      Agent Sidecar
apps/standalone/     future standalone app
```

Plugin and Agent Sidecar are distribution terms only. Every user-facing surface calls the product Esse, and a user is expected to install one distribution.

The Sidecar was imported as a source snapshot without the private repository's Git history, server, hosted billing, accounts, balances, channel administration, local data, or credentials. It does not depend on that repository.

## v0.3 alpha

- Keep the existing Plugin installer and archive layout compatible while moving its source to `plugins/codex`.
- Ship the Windows x64 Agent Sidecar installer in the same GitHub Release.
- Configure Providers locally in both distributions. Include Tuzi presets and model catalog data but never an API key.
- Keep Agent submission asynchronous: once Esse durably accepts Provider work, the Agent returns control without polling or copying outputs back unless asked.
- Maintain user-visible workflow parity and record semantic ports in `SYNC.md`.

## Near term

- Close remaining visual and MCP contract gaps between Plugin and Agent Sidecar.
- Add upgrade checks and a documented Sidecar uninstall path.
- Validate reference-image handoff in fresh WorkBuddy sessions using user-operated steps.
- Add macOS Sidecar packaging only after native manual validation is available.

## Later

- Decide whether duplication cost justifies extracting shared domain, Provider runtime, and UI packages. No distribution may depend on the other while this remains deferred.
- Define a true standalone application separately from the Agent Sidecar.
- Consider stable signing, automatic updates, and additional Providers after the alpha contract settles.

## Release policy

Use one SemVer tag and one GitHub Release. Group assets by technical distribution; do not maintain permanent `plugin` and `sidecar` Git branches. Alpha tags are prereleases. Plugin metadata remains in `latest.json`; Sidecar metadata is published as `sidecar-latest.json`; `checksums.txt` covers all artifacts.
