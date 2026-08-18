# Plugin and Agent Sidecar parity

Esse currently has two independent implementations. They intentionally do not share a runtime Core yet. When behavior is ported between `plugins/codex` and `sidecars/agent`, record the user-visible contract here instead of adding a cross-package dependency.

## 2026-07-21 — initial Sidecar import

The Agent Sidecar snapshot preserves the following Plugin behavior semantically:

- durable batches with independently queued jobs and background Provider execution;
- local Provider profiles, Tuzi presets, per-offering model and price metadata, configurable concurrency, and OS-protected API keys;
- original-file persistence, history versions, selection, modification, deletion, previews, zoom, and overlay dismissal;
- real reference-image transfer by absolute path or registered Esse image ID;
- MCP submission that returns after durable acceptance, without routine polling, price narration, or automatic result retrieval;
- unknown-charge outcomes are not automatically retried;
- Provider-returned remote image URLs use China-first trusted DNS resolution, private-network rejection, redirect revalidation, and pinned public-address downloads;
- one conversational product shorthand: Esse, with the configured edition display name used on edition-identifying surfaces.

The initial import deliberately excludes the private commercial server, user accounts, balances, channel administration, hosted billing, and all credentials. It also leaves the Plugin and Sidecar stores isolated.

## 2026-07-21 — Agent handoff hardening

- Esse is described consistently as a Provider-neutral local image task workspace and execution harness, not as an image model or model architecture. Agents must not infer capabilities such as text or number rendering from Esse itself.
- A sufficiently specified request that names Esse is submitted without a generic model-capability warning or second confirmation.
- The same contract is delivered through MCP initialization instructions, the optional MCP prompt, and the model-visible descriptions of every Provider submission tool.
- Provider-backed acceptance now returns only the background execution flag, the short user reply, and an explicit stop directive. It omits batch IDs, job IDs, status, and other details that could invite unsolicited monitoring. Agent-owned generation still returns the exact IDs required for callbacks.
- Status and render tools explicitly treat a completed handoff as insufficient authorization to poll; only a later explicit user request permits status lookup or output retrieval.

## 2026-07-21 — Windows Sidecar window chrome

- The Windows Agent Sidecar uses a light integrated draggable title bar with native window controls and removes Electron's default `File / Edit / View / Window` menu. The image workspace no longer opens inside a visually separate black frame.
- Non-Windows builds retain their native window chrome and menu behavior.

## 2026-07-21 — Agent Sidecar batch output access

- Opening a batch output folder now creates and opens one managed per-batch folder containing the batch's current images and preserved versions, matching the Plugin's batch-scoped output-folder contract.
- The Sidecar uses filesystem links where supported, keeps the original image-store paths stable, and removes its managed batch links when an image is moved to Esse's trash.
- The Sidecar home navigation now uses the Esse application icon, and the Electron window no longer imposes a minimum width.

## 2026-07-21 — macOS Agent Sidecar parity

- Windows x64 and macOS arm64/x64 now package the same Sidecar source and runtime core; only paths, native window behavior, signing/notarization, and installer artifacts vary by platform.
- macOS keeps the native title bar and application menu, stays active after the last window closes, uses Keychain-backed Electron safe storage, and stores data under `~/Library/Application Support/esse-agent-sidecar`.
- The macOS release pipeline builds architecture-specific DMGs and checks bundle IDs, Mach-O architecture, bundled Esse icon resources, and packaged-app startup. It verifies Developer ID signing and Apple notarization when credentials are configured. Without those credentials, Packager replaces the fuse tool's temporary signature with a complete ad-hoc signature after the bundle is finalized, and CI rejects any corrupted or non-ad-hoc result. This mode is still disclosed as lacking publisher identity and notarization.
- The Windows Squirrel application ID no longer owns `%LOCALAPPDATA%\esse`, preventing the installer from deleting Codex Plugin history. The installer root, Plugin data, and Sidecar data now have three distinct identities.
- Windows executable, installer, runtime title bar, macOS app bundle, and DMG all use the Esse application icon rather than Electron defaults.

## 2026-07-22 — edition boundary

- The public desktop product is now identified as Esse Community and keeps the original Provider-first settings with no first-run onboarding.
- Commercial onboarding and managed-service behavior live in a separate private downstream repository whose release line starts at `1.0.0`.
- `sidecars/agent/product.json` is the small edition overlay for names, bundle IDs, data directories, installer names, and release asset prefixes; build verification reads this profile on Windows and macOS.
- Shared gallery, retry, prompt-language, Agent handoff, MCP, and image-history fixes remain in the public upstream and are merged downstream.

## 2026-07-23 — per-job Agent reference isolation

- Agent-owned batches expose only callback-safe batch/job summaries until `start_agent_image_job` is called for one exact job.
- Each start call returns only that job's Prompt and reference paths. Concurrent jobs remain separate outbound image-generation requests; reference paths and request-size checks must never be aggregated across the batch.

## 2026-07-23 — copyable batch and image references

- The active batch title exposes an adjacent copy control that writes the batch title and exact `batchId` to the native system clipboard.
- Image context menus keep binary image copying separate from a new `复制图片 ID` action that writes the exact `imageId`.
- The Plugin and Agent Sidecar use the same self-describing text format so a user can paste an unambiguous batch and image target into an Agent conversation.

## 2026-07-23 — edition display names and window layout

- Edition-identifying surfaces use the product profile: the public edition displays `Esse Community`, while the private downstream displays `Esse`. Stable technical IDs and the ordinary “use Esse” Agent instruction remain unchanged.
- Sidecar window titles append the installed package version so screenshots and support reports identify the exact build.
- The Windows batch workspace subtracts the integrated title-bar overlay height from its minimum page height, preventing an empty root-page vertical scrollbar without hiding legitimate scrollable content.

## 2026-07-23 — Sidecar Provider network isolation

- Windows and macOS Sidecars route Provider requests and connection tests through an isolated Electron session backed by Chromium's network stack, so current system proxy and network changes are handled consistently.
- A transport failure is returned to its own caller immediately and is never automatically retried. Esse does not reset shared connections, DNS, or proxy state after a request fails; a later explicit request starts independently through the same isolated session.
- Safe transport codes such as `ETIMEDOUT` or `ERR_NETWORK_CHANGED` are shown with the existing unknown-charge message; URLs, credentials, and raw network errors remain hidden.

## 2026-07-24 — structured error attribution

- Failed jobs and individual call records persist an explicit `upstream`, `esse`, or `transport` error origin instead of relying on message-prefix parsing. Existing records without that field remain readable and are identified as historical errors.
- Provider HTTP error bodies are preserved as the upstream message without an Esse-owned failure prefix. Response-validation, image-import, and interrupted-process failures are attributed to the Esse-side path; Agent-reported generation failures are upstream. Requests that never receive an HTTP response are labeled `请求链路`, because neither Esse nor the upstream service can be blamed conclusively from that evidence.
- Both UIs show a compact source badge beside the error. The Sidecar product profile controls whether Provider identity appears in error surfaces and can redact edition-specific Provider terms from raw upstream messages.
- Provider and Agent Sidecar image-generation requests now allow up to 15 minutes for queue-heavy models to respond. Connection tests retain their short timeout, and a terminal timeout remains an unknown-result failure that is never retried automatically.

## 2026-08-05 — bounded Sidecar thumbnail rendering

- Sidecar galleries and batch-browser cards use a disposable 512-pixel preview cache instead of decoding full-resolution originals for thumbnail surfaces. The original files remain untouched and are loaded only for explicit full-image and file operations.
- Preview generation is serialized and deduplicated, cached data is capped and pruned, and missing or corrupt previews fall back without making the original image unavailable.
- Renderer image sources are attached only near the viewport and removed again when far offscreen. Chromium lazy decoding plus offscreen paint containment keeps loaded and decoded image counts bounded as batch history grows.
- A cross-platform Electron stress E2E opens 120 high-resolution historical batches and rejects eager original loading or unbounded preview generation before Windows or macOS release packaging.
- QA and packaged-app smoke sessions use an ephemeral MCP pairing token so headless macOS runners never reuse or prompt for a persistent Keychain entry. macOS smoke cleanup escalates from a bounded graceful stop to a forced stop instead of waiting indefinitely.

## 2026-08-18 — batch-local Sidecar runtime updates

- Durable batch acceptance no longer waits for a desktop-wide state rebuild. A background job change publishes only that batch snapshot and the exact image IDs added or removed by the change; unrelated batches, Provider settings, and the full image library are not reconstructed or copied over IPC.
- The Sidecar reads and indexes `library.json` once per process. Image lookup is indexed, visible-image results are maintained incrementally, and repeated MCP status enrichment no longer reparses the complete library for every image.
- Provider execution has a default global bound of three jobs and schedules one eligible job per batch per pass. Reference files within one job are encoded sequentially, keeping image preparation bounded without changing prompts, references, task states, or Provider payloads.
- Provider and transport errors finish the affected job after the first failed call. Esse retains explicit user-initiated retry, including the existing unknown-charge confirmation rule, but performs no automatic retry or shared network recovery.

## Deferred

- shared domain/provider/UI packages;
- physical-device macOS UI validation beyond GitHub-hosted arm64/x64 packaging and smoke checks;
- a true standalone application under `apps/standalone`.
