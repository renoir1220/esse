# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

This policy applies to the Windows x64 and macOS arm64/x64 Esse Community Agent Sidecar distributed from this repository's [GitHub Releases](https://github.com/renoir1220/esse/releases). Signing credentials are not currently a release prerequisite. When a complete platform credential set is available, the workflow signs and verifies that platform. When no credentials are configured, the workflow verifies that the artifacts are unsigned and the release notes disclose that status. A partial credential set is always a release error.

## Team roles

- Committer and reviewer: [Renoir](https://github.com/renoir1220)
- Signing-request approver: [Renoir](https://github.com/renoir1220)

Changes from other contributors require review by the maintainer. Every signing request requires explicit approval by the signing-request approver.

## Signed artifacts and provenance

The policy covers the Windows Sidecar application executable and its installer, plus both architecture-specific macOS app bundles and DMGs. Release artifacts must be built by the repository's GitHub Actions workflow from the tagged public source revision. Signed Windows builds are checked for Authenticode signatures and trusted timestamps. Signed macOS builds are checked for Developer ID signing, Gatekeeper assessment, notarization, and a stapled ticket. Unsigned builds are checked as unsigned and still pass architecture, package, icon, startup, and checksum validation.

No binary built from unpublished or proprietary source is eligible for this signing policy.

The Windows release job accepts an approved Authenticode certificate only through the repository secrets `WINDOWS_CERTIFICATE_PFX_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`. macOS signing and notarization require the complete documented Developer ID and App Store Connect secret set. The workflow materializes credentials only in runner temporary storage, passes them to Electron Forge, and verifies signed artifacts before upload. Signing material must never be committed to the repository, written to release assets, or pasted into an issue or pull request.

## Privacy

Esse does not transfer information to another networked system unless specifically requested by the user or the person installing or operating it. Provider configuration, API keys, batch records, and source images stay on the local computer by default.

When a user explicitly requests image generation or editing, Esse sends the prompt and selected reference images only to the Provider configured by that user or to the current Agent's image-generation capability. Provider credentials are not included in this repository or its release artifacts. The selected Provider's own privacy policy and terms apply to those requests.
