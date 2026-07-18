---
name: batch-generate-images
description: Inspect local image folders and run parallel image generation or editing batches through esse. Use when the user mentions esse, wants to generate many images, apply one visual change across a folder, prepare per-image prompts after seeing source images, monitor a batch, select generated results, or modify one or more completed images again.
---

# Batch Generate Images

Use the local esse MCP tools. Keep the model, price tier, credential profile, and API adapter together as one offering.

## Workflow

1. Call `list_image_offerings`. If none is configured, call `open_esse` with `tab: settings` and let the user configure one locally. Never ask for an API key in chat.
2. When the request depends on image content, call `inspect_image_folder` before writing prompts. Page through the folder when needed; do not claim to have inspected unseen images.
3. Choose one shared prompt when the same edit applies to all files. Add `perImagePrompts` only for images that genuinely need different treatment.
4. Call `create_image_batch` once with the whole folder or explicit image paths. Use a stable `requestKey` for the same user-approved batch so a repeated tool call does not duplicate charges.
5. Do not call `render_image_batch` after routine create, status, retry, or modify operations. An esse sidebar that is already open refreshes local state itself; opening another widget would disturb the user's layout. Call `open_esse` only when the user explicitly asks to open or show esse.
6. When the user selects results and describes another change, call `modify_selected_images` with the selected job IDs. The main image is updated inside the same batch and the previous version is kept as `图1-1`, `图1-2`, and so on. Reuse the original offering.

## Guardrails

- Tell the user that selected files are sent to the chosen external Provider.
- Never overwrite source images. Use the batch output directory returned by the tool.
- Do not automatically retry a failed request whose `chargeState` is `unknown`; ask the user to confirm the possible duplicate charge.
- Definitely-not-charged retryable failures may retry automatically up to three times. Unknown-charge failures always require the user's explicit retry action.
- Preserve local paths exactly. Do not invent filenames or claim a folder was processed before the batch reaches a terminal status.
- Limit one batch to 50 images. Split larger folders into deliberate batches with distinct request keys.
