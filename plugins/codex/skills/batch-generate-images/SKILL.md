---
name: batch-generate-images
description: Use for every request that mentions esse. Open Esse when absent; preserve each job's own prompt and references; resolve prior Esse results structurally; use the configured default model; and when Esse selects Codex 生成, generate with the current Agent's available image capability and return each result to Esse.
---

# Batch Generate Images

Use the local Esse MCP tools. Let Esse resolve the user's configured default offering. Treat `agent-generation` as cooperation with the current Agent, not as an OAuth or API Provider.

## Workflow

1. Treat any request to use esse as permission to show the esse workbench. If the current conversation context does not already include an active Esse MCP App/widget, call `open_esse` before doing the requested work. Use `tab: settings` only for setup; otherwise use `tab: batches` and include a known `batchId` when available. The widget requests Codex's expanded side view itself. If an active Esse MCP App context is already present, do not open a duplicate.
2. For ordinary generation, omit `offeringId`. Esse must use the default model configured by the user. Do not call `list_image_offerings` or compare models just because several are available. Never select a model based on price, subject, capability, or your own preference.
3. Write every image prompt in the language the user is currently using. Chinese requests must produce Chinese image prompts. If the user's language cannot be determined, default to Simplified Chinese. Use English prompts only when the user explicitly requests English.
4. Only when the user explicitly names a different model or asks to inspect/change models, call `list_image_offerings` and pass an exact matching `offeringId`. If the requested model is ambiguous, ask the user. If no default is configured, open `settings` and let the user choose one; never choose the first model automatically. Never ask for an API key in chat.
5. When the request depends on image content, call `inspect_image_folder` before writing prompts. Page through the folder when needed; do not claim to have inspected unseen images.
6. Treat each batch child as an independent task with its own prompt and zero or more references. Use `jobs[]` whenever prompts or references differ. For ordinary local files use `referenceImagePaths`. Use top-level references only when every child intentionally shares them. Do not assume that references apply to the whole batch.
7. When the user says to use an existing Esse result such as `图1` or `图1-1` as a reference, it is a real image attachment requirement, not merely prompt wording. Pass `referenceImages: [{ batchId, image: "图1" }]` on the affected child job. If the batch ID is not already known from the conversation or tool result, call `list_image_batches` with a limit from 1 to 50 and resolve the intended batch; if multiple batches are plausible, ask the user. Never invent an output path, never copy only the label into the prompt, and never silently omit the reference. A later user request to reuse a finished result explicitly permits this lookup and is not prohibited polling.
8. For a genuinely new generation request, call `create_image_batch` once for the approved batch. Never use it to fulfill a request to modify an existing image. Use a stable `requestKey` so repeated calls do not duplicate work or charges. Tell the user only when local reference files will be sent to the selected external Provider or, for Codex 生成, to the current Agent's image-generation service/model. The docked Esse sidebar discovers and activates the new batch automatically; do not open a duplicate widget.
9. When the user asks to append, add, or generate more images in an existing batch, call `append_image_batch_jobs` with that exact `batchId`. This tool can append to active or terminal batches and assigns the next image names in place. Never create a temporary batch or use `merge_image_batches` to simulate append. Omit `offeringId` to reuse the batch model; pass it only when the user explicitly names another model. Use a stable `requestKey`.
10. Inspect the returned offering. For normal Provider offerings, stop after a successful `create_image_batch`, `append_image_batch_jobs`, or `modify_selected_images`; do not poll, monitor, or follow up unless the user asks.
11. When the returned job offering has `adapterId: agent-generation`, complete it with the current Agent's available image-generation capability. For append requests, act only on the returned `appendedJobIds`:
   - Do not require OAuth, API keys, Codex CLI, or a particular image tool. Use whatever image capability the current Agent already has.
   - Choose any safe execution strategy the Agent supports. Subagents are an optional way to parallelize independent jobs, not a requirement. Native batching, other concurrency, or sequential execution are valid.
   - If the current Agent cannot generate images, call `fail_agent_image_job` for every pending job with the real reason and tell the user that the current Agent does not support image generation. Do not leave jobs pending.
   - Before generating a job, call `start_agent_image_job`. Use its exact `prompt` and every returned `referenceImagePaths` entry. For a built-in image tool that requires visible local references, inspect each reference first.
   - On success, call `complete_agent_image_job` with the real absolute local output path. On failure, call `fail_agent_image_job`. Never invent a path or submit an inline-only image that was not saved locally.
   - Do not poll Esse. Each start, completion, and failure call updates the workbench directly.
12. When the user describes another change, resolve the target images before submitting work:
   - If the current Esse MCP App context says the user selected images, treat phrases such as “我选择的图片” or “选中的图片” as those exact image IDs and local paths. Selection may contain a current result, a backup such as `图2-1`, or the source image retained by a failed job.
   - If the user explicitly names images such as `图1`, `图2`, or `图2-1`, resolve those exact names from the current batch. Names embedded in a request sent by the Esse modification composer are already resolved; do not ask again.
   - If no image is selected or named and the current batch has more than one available image, do not guess. Ask which image to modify and remind the user that they can type a name such as `图1`, or double-click images in Esse to select them.
   - If the batch has exactly one available image, an otherwise unambiguous modification request may target that sole image.
   - Call `modify_selected_images` once with `batchId` and every exact resolved image ID in `imageIds`, whether each target is a current result, a backup, or a failed-job source. Never call `create_image_batch` for this workflow.
   - A current successful result is updated in place and its previous version is kept as `图1-1`, `图1-2`, and so on. A selected backup or failed-job source creates a new job inside the same batch using that exact image; never substitute a different image.
   Pass `offeringId` only when the user explicitly names a model or selected it in the Esse widget; otherwise omit it so Esse reuses the batch model. Then follow the normal-Provider or `agent-generation` branch above.
13. When the user explicitly asks to delete images, resolve exact current-image or backup IDs and call `delete_esse_images`. Deleting a current image also deletes its preserved versions. Do not delete queued or running images, and do not treat deleting an image as permission to delete its whole batch.
14. When the user explicitly asks to combine distinct batches, call `merge_image_batches` with one exact `targetBatchId` and the exact `sourceBatchIds`. Do not use merge for append requests. Batches must be terminal and the merged target may contain at most 50 images. Preserve source batches by default; set `deleteSourceBatches: true` only when the user explicitly asks to remove them. Use a stable `requestKey`.

## Guardrails

- Tell the user where selected files are sent: the chosen external Provider, or the current Agent's image-generation service/model for Codex 生成.
- Treat all price metadata as an estimate, not a bill or guaranteed charge. Do not volunteer or repeat price narration for routine generation. Mention a concise estimated amount only when the user asks about cost, compares models, or a higher-level policy explicitly requires confirmation.
- Never overwrite source images. Use the batch output directory returned by the tool.
- For normal Provider offerings, do not automatically retry a failed request whose `chargeState` is `unknown`. A direct click on Esse's retry button is already the user's explicit retry decision and must not trigger a second confirmation. Definitely-not-charged retryable failures may retry automatically up to three times.
- For Codex 生成, let the current Agent decide its own supported execution method, but always report a terminal success or failure to Esse.
- Preserve local paths exactly. Do not invent filenames or claim a folder was processed before the batch reaches a terminal status.
- Existing Esse images must be passed structurally through `referenceImages`; a matching phrase in the prompt does not count as attaching the image.
- Never infer one target from a multi-image batch when neither the user nor the Esse selection context identifies it. Treat current results, backups, and failed-job source images as distinct selectable images.
- Limit one batch creation, append, image-ID mutation, merge source list, and `list_image_batches` query to 50 items. Split larger work into deliberate operations with distinct request keys.
