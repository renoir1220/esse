---
name: batch-generate-images
description: Use for every request that mentions esse. Open Esse when absent; preserve each job's own prompt and references; resolve prior Esse results structurally; use the configured default model; and when Esse selects Codex 生成, generate with the current Agent's available image capability and return each result to Esse.
---

# Batch Generate Images

Use the local Esse MCP tools. Let Esse resolve the user's configured default offering. Treat `agent-generation` as cooperation with the current Agent, not as an OAuth or API Provider.

## Workflow

1. Treat any request to use esse as permission to show the esse workbench. If the current conversation context does not already include an active Esse MCP App/widget, call `open_esse` before doing the requested work. Use `tab: settings` only for setup; otherwise use `tab: batches` and include a known `batchId` when available. The widget requests Codex's expanded side view itself. If an active Esse MCP App context is already present, do not open a duplicate.
2. For ordinary generation, omit `offeringId`. Esse must use the default model configured by the user. Do not call `list_image_offerings` or compare models just because several are available. Never select a model based on price, subject, capability, or your own preference.
3. Only when the user explicitly names a different model or asks to inspect/change models, call `list_image_offerings` and pass an exact matching `offeringId`. If the requested model is ambiguous, ask the user. If no default is configured, open `settings` and let the user choose one; never choose the first model automatically. Never ask for an API key in chat.
4. When the request depends on image content, call `inspect_image_folder` before writing prompts. Page through the folder when needed; do not claim to have inspected unseen images.
5. Treat each batch child as an independent task with its own prompt and zero or more references. Use `jobs[]` whenever prompts or references differ. For ordinary local files use `referenceImagePaths`. Use top-level references only when every child intentionally shares them. Do not assume that references apply to the whole batch.
6. When the user says to use an existing Esse result such as `图1` or `图1-1` as a reference, it is a real image attachment requirement, not merely prompt wording. Pass `referenceImages: [{ batchId, image: "图1" }]` on the affected child job. If the batch ID is not already known from the conversation or tool result, call `list_image_batches` and resolve the intended batch; if multiple batches are plausible, ask the user. Never invent an output path, never copy only the label into the prompt, and never silently omit the reference. A later user request to reuse a finished result explicitly permits this lookup and is not prohibited polling.
7. Call `create_image_batch` once for the approved batch. Use a stable `requestKey` so repeated calls do not duplicate work or charges. Tell the user that references will be sent to the selected external Provider or, for Codex 生成, to the current Agent's image-generation service/model.
8. Inspect the returned offering. For normal Provider offerings, stop after a successful `create_image_batch` or `modify_selected_images`; do not poll, monitor, or follow up unless the user asks.
9. When the returned job offering has `adapterId: agent-generation`, complete it with the current Agent's available image-generation capability:
   - Do not require OAuth, API keys, Codex CLI, or a particular image tool. Use whatever image capability the current Agent already has.
   - Choose any safe execution strategy the Agent supports. Subagents are an optional way to parallelize independent jobs, not a requirement. Native batching, other concurrency, or sequential execution are valid.
   - If the current Agent cannot generate images, call `fail_agent_image_job` for every pending job with the real reason and tell the user that the current Agent does not support image generation. Do not leave jobs pending.
   - Before generating a job, call `start_agent_image_job`. Use its exact `prompt` and every returned `referenceImagePaths` entry. For a built-in image tool that requires visible local references, inspect each reference first.
   - On success, call `complete_agent_image_job` with the real absolute local output path. On failure, call `fail_agent_image_job`. Never invent a path or submit an inline-only image that was not saved locally.
   - Do not poll Esse. Each start, completion, and failure call updates the workbench directly.
10. When the user selects results and describes another change, call `modify_selected_images` with the selected job IDs. The main image is updated inside the same batch and the previous version is kept as `图1-1`, `图1-2`, and so on. Pass `offeringId` only when the user explicitly names a model or selected it in the Esse widget; otherwise omit it so Esse reuses the batch model. Then follow the normal-Provider or `agent-generation` branch above.

## Guardrails

- Tell the user where selected files are sent: the chosen external Provider, or the current Agent's image-generation service/model for Codex 生成.
- Never overwrite source images. Use the batch output directory returned by the tool.
- For normal Provider offerings, do not automatically retry a failed request whose `chargeState` is `unknown`; ask the user to confirm the possible duplicate charge. Definitely-not-charged retryable failures may retry automatically up to three times.
- For Codex 生成, let the current Agent decide its own supported execution method, but always report a terminal success or failure to Esse.
- Preserve local paths exactly. Do not invent filenames or claim a folder was processed before the batch reaches a terminal status.
- Existing Esse images must be passed structurally through `referenceImages`; a matching phrase in the prompt does not count as attaching the image.
- Limit one batch to 50 images. Split larger folders into deliberate batches with distinct request keys.
