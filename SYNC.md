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
- one user-facing product name: Esse.

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

## Deferred

- shared domain/provider/UI packages;
- macOS Agent Sidecar packaging and manual validation;
- a true standalone application under `apps/standalone`.
