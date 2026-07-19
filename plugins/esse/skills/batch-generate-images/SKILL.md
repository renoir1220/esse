---
name: batch-generate-images
description: Use for every request that mentions esse. Open Esse when absent; use jobs with each child's own prompt and references; resolve existing Esse results through referenceImages; omit offeringId for the configured default model; after a successful create or modify call, never poll unless the user explicitly asks.
---

# Batch Generate Images

Use the local esse MCP tools. Keep the model, price tier, credential profile, and API adapter together as one offering. Let Esse resolve the user's configured default offering.

## Workflow

1. Treat any request to use esse as permission to show the esse workbench. If the current conversation context does not already include an active Esse MCP App/widget, call `open_esse` before doing the requested work. Use `tab: settings` only for setup; otherwise use `tab: batches` and include a known `batchId` when available. The widget requests Codex's expanded side view itself. If an active Esse MCP App context is already present, do not open a duplicate.
2. For ordinary generation, omit `offeringId`. Esse must use the default model configured by the user. Do not call `list_image_offerings` or compare models just because several are available. Never select a model based on price, subject, capability, or your own preference.
3. Only when the user explicitly names a different model or asks to inspect/change models, call `list_image_offerings` and pass an exact matching `offeringId`. If the requested model is ambiguous, ask the user. If no default is configured, open `settings` and let the user choose one; never choose the first model automatically. Never ask for an API key in chat.
4. When the request depends on image content, call `inspect_image_folder` before writing prompts. Page through the folder when needed; do not claim to have inspected unseen images.
5. Treat each batch child as an independent task with its own prompt and zero or more references. Use `jobs[]` whenever prompts or references differ. For ordinary local files use `referenceImagePaths`. Use top-level references only when every child intentionally shares them. Do not assume that references apply to the whole batch.
6. When the user says to use an existing Esse result such as `图1` or `图1-1` as a reference, it is a real image attachment requirement, not merely prompt wording. Pass `referenceImages: [{ batchId, image: "图1" }]` on the affected child job. If the batch ID is not already known from the conversation or tool result, call `list_image_batches` and resolve the intended batch; if multiple batches are plausible, ask the user. Never invent an output path, never copy only the label into the prompt, and never silently omit the reference. A later user request to reuse a finished result explicitly permits this lookup and is not prohibited polling.
7. Call `create_image_batch` once for the approved batch. Use a stable `requestKey` so a repeated tool call does not duplicate charges. Tell the user before submission that local and existing-result reference files are sent to the configured external Provider.
8. After `create_image_batch` or `modify_selected_images` returns without an immediate error, stop managing the task. Do not call `get_image_batch`, `render_image_batch`, wait, poll, monitor, or send progress follow-ups. Give at most a brief handoff that the task is visible in Esse, then allow the human to continue the next conversation turn. Check status later only if the user explicitly asks.
9. When the user selects results and describes another change, call `modify_selected_images` with the selected job IDs. The main image is updated inside the same batch and the previous version is kept as `图1-1`, `图1-2`, and so on. For Agent calls, pass `offeringId` only when the user explicitly names a model; otherwise omit it so Esse reuses the batch model. A model chosen by the user in the Esse widget is an explicit choice and must be honored.

## Guardrails

- Tell the user that selected files are sent to the chosen external Provider.
- Never overwrite source images. Use the batch output directory returned by the tool.
- Do not automatically retry a failed request whose `chargeState` is `unknown`; ask the user to confirm the possible duplicate charge.
- Definitely-not-charged retryable failures may retry automatically up to three times. Unknown-charge failures always require the user's explicit retry action.
- Preserve local paths exactly. Do not invent filenames or claim a folder was processed before the batch reaches a terminal status.
- Existing Esse images must be passed structurally through `referenceImages`; a matching phrase in the prompt does not count as attaching the image.
- Limit one batch to 50 images. Split larger folders into deliberate batches with distinct request keys.
