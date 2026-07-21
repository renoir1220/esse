# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

This policy applies to the Windows x64 Esse Agent Sidecar distributed from this repository's [GitHub Releases](https://github.com/renoir1220/esse/releases). The SignPath Foundation application is pending; until it is approved and the release workflow verifies a trusted Authenticode signature, Windows Sidecar builds are development artifacts and are not published as signed releases.

## Team roles

- Committer and reviewer: [Renoir](https://github.com/renoir1220)
- Signing-request approver: [Renoir](https://github.com/renoir1220)

Changes from other contributors require review by the maintainer. Every signing request requires explicit approval by the signing-request approver.

## Signed artifacts and provenance

The policy covers the Windows Sidecar application executable and its installer. Release artifacts must be built by the repository's GitHub Actions workflow from the tagged public source revision. The workflow verifies both Authenticode signatures and their trusted timestamps before it publishes any release asset.

No binary built from unpublished or proprietary source is eligible for this signing policy.

## Privacy

Esse does not transfer information to another networked system unless specifically requested by the user or the person installing or operating it. Provider configuration, API keys, batch records, and source images stay on the local computer by default.

When a user explicitly requests image generation or editing, Esse sends the prompt and selected reference images only to the Provider configured by that user or to the current Agent's image-generation capability. Provider credentials are not included in this repository or its release artifacts. The selected Provider's own privacy policy and terms apply to those requests.
