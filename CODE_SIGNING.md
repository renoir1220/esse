# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

This policy applies to the Windows x64 and macOS arm64/x64 Esse Agent Sidecar distributed from this repository's [GitHub Releases](https://github.com/renoir1220/esse/releases). The SignPath Foundation application is pending. `v0.3.0-alpha.2` and `v0.3.0` are explicitly unsigned Windows exceptions requested by the maintainer and may trigger Windows publisher or reputation warnings. Every later Windows release remains behind the trusted Authenticode signature and timestamp gate unless another exact exception is publicly reviewed and documented. macOS releases have no unsigned exception: they require Developer ID signing and Apple notarization.

## Team roles

- Committer and reviewer: [Renoir](https://github.com/renoir1220)
- Signing-request approver: [Renoir](https://github.com/renoir1220)

Changes from other contributors require review by the maintainer. Every signing request requires explicit approval by the signing-request approver.

## Signed artifacts and provenance

The policy covers the Windows Sidecar application executable and its installer, plus both architecture-specific macOS app bundles and DMGs. Release artifacts must be built by the repository's GitHub Actions workflow from the tagged public source revision. The workflow verifies Windows Authenticode signatures and trusted timestamps; for macOS it verifies the Developer ID signature, Gatekeeper assessment, notarization ticket, bundle architecture, and application icon before it publishes any release asset.

No binary built from unpublished or proprietary source is eligible for this signing policy.

## Privacy

Esse does not transfer information to another networked system unless specifically requested by the user or the person installing or operating it. Provider configuration, API keys, batch records, and source images stay on the local computer by default.

When a user explicitly requests image generation or editing, Esse sends the prompt and selected reference images only to the Provider configured by that user or to the current Agent's image-generation capability. Provider credentials are not included in this repository or its release artifacts. The selected Provider's own privacy policy and terms apply to those requests.
