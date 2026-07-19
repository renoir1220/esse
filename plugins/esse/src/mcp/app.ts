import { randomUUID } from "node:crypto";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { BatchManager } from "../jobs/batch-manager.js";
import { scanImageFolder } from "../files/image-files.js";
import { fileDataUrl } from "../files/output-files.js";
import { saveFileAs } from "../files/save-file-dialog.js";
import { openLocalFolder } from "../files/open-folder.js";
import type { Thumbnailer } from "../files/thumbnailer.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SettingsStore } from "../storage/settings-store.js";
import type { AdapterId, BatchSnapshot, JobRecord, OfferingConfig } from "../types.js";

export const WIDGET_URI = "ui://esse/local-v1.html";

const priceSchema = z.object({
  mode: z.enum(["per_request", "token", "model_quota", "unknown"]),
  currency: z.string().min(1).max(8).default("CNY"),
  amount: z.number().nonnegative().optional(),
  inputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative().optional(),
  observedAt: z.string().optional(),
  note: z.string().max(300).optional()
});

const offeringInputSchema = z.object({
  id: z.string().optional(),
  canonicalModelId: z.string().min(1).max(160),
  providerModelId: z.string().min(1).max(160),
  displayName: z.string().min(1).max(160),
  price: priceSchema,
  supportsTextToImage: z.boolean().default(true),
  supportsImageToImage: z.boolean().default(true),
  sizes: z.array(z.string()).max(30).default([]),
  qualities: z.array(z.string()).max(20).default([])
});

const existingImageReferenceSchema = z.object({
  batchId: z.string().min(1).describe("ID of the existing Esse batch that owns the reference image."),
  image: z.string().min(1).describe("Exact image name such as 图1 or 图1-1, or its returned job/backup ID.")
});

export function createLocalEsseServer(options: {
  widgetHtml: string;
  settings: SettingsStore;
  registry: ProviderRegistry;
  batches: BatchManager;
  thumbnailer: Thumbnailer;
  saveFileAs?: typeof saveFileAs;
  openFolder?: typeof openLocalFolder;
}): McpServer {
  const server = new McpServer(
    { name: "esse", version: "0.1.0" },
    {
      instructions:
        "esse runs local image batches. Use the locally configured default offering unless the user explicitly requests another model; do not choose a model on the user's behalf. Codex 生成 delegates each job to the current Agent's own image-generation capability; the Agent may use any available concurrency method and must return success or failure through the Agent job tools. Inspect local folders before image-aware work. When a user refers to an existing Esse result such as 图1, pass it through referenceImages with its batchId and exact image name; never leave the reference only in prompt text or invent a local path. Routine tools are headless so an already docked sidebar keeps its layout."
    }
  );

  registerAppResource(server, "esse-ui", WIDGET_URI, {}, async () => ({
    contents: [{
      uri: WIDGET_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: options.widgetHtml,
      _meta: {
        ui: { prefersBorder: false },
        "openai/widgetDescription": "本地图片工作台：Provider 设置、文件夹批处理、并行进度、预览、选择和再次修改。"
      }
    }]
  }));

  registerAppTool(server, "open_esse", {
    title: "Open esse",
    description: "Opens esse for provider setup, recent batches, progress, previews, and selections.",
    inputSchema: { tab: z.enum(["batches", "settings"]).default("batches"), batchId: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: widgetToolMeta("正在打开本地图片工作台…", "本地图片工作台已打开")
  }, async ({ tab, batchId }) => appResult(await uiState(options, tab, batchId)));

  registerAppTool(server, "list_image_offerings", {
    title: "List local image offerings",
    description: "Lists configured offerings only when the user explicitly asks to inspect or override the default model. Do not use this list to choose a model on the user's behalf.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["model", "app"] } }
  }, async () => {
    const offerings = await options.registry.listOfferings();
    return {
      structuredContent: { offerings },
      content: [{ type: "text", text: offerings.length ? `${offerings.length} local image offerings are configured.` : "No image provider is configured. Open esse settings first." }]
    };
  });

  registerAppTool(server, "inspect_image_folder", {
    title: "Inspect local image folder",
    description: "Reads image filenames and model-visible thumbnails from a local folder so GPT can understand the images and prepare shared or per-image prompts before creating a batch.",
    inputSchema: {
      folderPath: z.string().min(1),
      recursive: z.boolean().default(false),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(12).default(8)
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["model", "app"] } }
  }, async ({ folderPath, recursive, page, pageSize }) => {
    const scanned = await scanImageFolder({ folderPath, recursive, maxImages: 500 });
    const start = (page - 1) * pageSize;
    const pageFiles = scanned.files.slice(start, start + pageSize);
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{
      type: "text",
      text: `Folder: ${scanned.folderPath}\nImages: ${scanned.files.length}${scanned.truncated ? "+" : ""}\nShowing ${start + 1}-${Math.min(start + pageFiles.length, scanned.files.length)}. Image labels below include exact local paths.`
    }];
    for (const [index, file] of pageFiles.entries()) {
      content.push({ type: "text", text: `Image ${start + index + 1}: ${file.path}` });
      const preview = await options.thumbnailer.dataUrl(file.path, 960);
      if (preview) {
        const parsed = splitDataUrl(preview);
        content.push({ type: "image", data: parsed.data, mimeType: parsed.mimeType });
      } else content.push({ type: "text", text: "Preview unavailable; use the filename and path only." });
    }
    return {
      structuredContent: {
        folderPath: scanned.folderPath,
        files: pageFiles,
        page,
        pageSize,
        total: scanned.files.length,
        hasMore: start + pageFiles.length < scanned.files.length
      },
      content
    };
  });

  registerAppTool(server, "create_image_batch", {
    title: "Create local parallel image batch",
    description: "Creates a local persistent batch using the configured default model when offeringId is omitted. Each jobs[] item has its own prompt and zero or more references. If the resolved offering uses agent-generation, the current Agent must generate each job with any image capability and concurrency method it supports, then call start_agent_image_job and complete_agent_image_job or fail_agent_image_job. For existing Esse results such as 图1, use referenceImages with batchId + image so Esse resolves the real output file.",
    inputSchema: {
      title: z.string().max(120).optional(),
      offeringId: z.string().min(1).optional(),
      prompt: z.string().min(1).max(5000).optional(),
      perImagePrompts: z.record(z.string()).optional(),
      folderPath: z.string().optional(),
      recursive: z.boolean().default(false),
      imagePaths: z.array(z.string()).max(50).optional(),
      referenceImagePaths: z.array(z.string()).max(20).optional(),
      referenceImages: z.array(existingImageReferenceSchema).max(20).optional(),
      jobs: z.array(z.object({
        prompt: z.string().min(1).max(5000),
        referenceImagePaths: z.array(z.string()).max(20).default([]),
        referenceImages: z.array(existingImageReferenceSchema).max(20).default([])
      })).min(1).max(50).optional(),
      maxImages: z.number().int().min(1).max(50).default(50),
      outputDirectory: z.string().optional(),
      count: z.number().int().min(1).max(50).optional(),
      size: z.string().optional(),
      quality: z.string().optional(),
      requestKey: z.string().max(200).optional()
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    _meta: headlessToolMeta()
  }, async (input) => {
    if (!input.prompt && !input.jobs?.length) throw new Error("请提供批次 prompt，或为每个 jobs[] 子任务分别提供 prompt。");
    let imagePaths = input.imagePaths || [];
    if (input.folderPath) {
      const scanned = await scanImageFolder({ folderPath: input.folderPath, recursive: input.recursive, maxImages: input.maxImages });
      imagePaths = [...imagePaths, ...scanned.files.map((file) => file.path)];
    }
    imagePaths = [...new Set(imagePaths)].slice(0, input.maxImages);
    const settings = await options.settings.load();
    const offeringId = input.offeringId || settings.defaultOfferingId;
    if (!offeringId) throw new Error("请先在 Esse 设置中选择默认模型；未明确指定时不会由 Agent 代替你选择。");
    const referenceImagePaths = [
      ...(input.referenceImagePaths || []),
      ...resolveExistingImagePaths(options.batches, input.referenceImages)
    ];
    const jobs = input.jobs?.map((job) => ({
      prompt: job.prompt,
      referenceImagePaths: [
        ...(job.referenceImagePaths || []),
        ...resolveExistingImagePaths(options.batches, job.referenceImages)
      ]
    }));
    const batch = await options.batches.create({
      title: input.title,
      offeringId,
      prompt: input.prompt || "各子任务使用独立 Prompt",
      perImagePrompts: input.perImagePrompts,
      imagePaths,
      referenceImagePaths,
      jobs,
      inputDirectory: input.folderPath,
      outputDirectory: input.outputDirectory,
      count: input.count,
      size: input.size,
      quality: input.quality,
      requestKey: input.requestKey
    });
    const message = batch.offering.adapterId === "agent-generation"
      ? `已创建 ${batch.total} 个“Codex 生成”任务。请由当前 Agent 使用自身可用的图像生成能力完成每个 job，并通过 Agent job 接口回传结果；结果目录：${batch.outputDirectory}`
      : `已创建 ${batch.total} 个本地任务，${batch.offering.concurrency} 路并发，结果目录：${batch.outputDirectory}`;
    return batchResult(batch, message, true);
  });

  registerAppTool(server, "start_agent_image_job", {
    title: "Start Agent image job",
    description: "Marks one Codex 生成 job as running and returns its exact prompt and local reference paths. Use only when the batch offering adapterId is agent-generation. The Agent may use subagents, native batching, or any other available generation method; no specific concurrency mechanism is required.",
    inputSchema: { batchId: z.string().min(1), jobId: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: headlessToolMeta()
  }, async ({ batchId, jobId }) => {
    const batch = await options.batches.startAgentJob(batchId, jobId);
    const job = batch.jobs.find((entry) => entry.id === jobId)!;
    return agentJobResult(batch, job, `已开始 ${job.name}。请使用返回的准确 Prompt 和参考图生成图片。`);
  });

  registerAppTool(server, "complete_agent_image_job", {
    title: "Complete Agent image job",
    description: "Copies one image produced by the current Agent into the matching Codex 生成 job. Call exactly once after successful generation and pass the real absolute local image path.",
    inputSchema: { batchId: z.string().min(1), jobId: z.string().min(1), imagePath: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: headlessToolMeta()
  }, async ({ batchId, jobId, imagePath }) => {
    const batch = await options.batches.completeAgentJob(batchId, jobId, imagePath);
    const job = batch.jobs.find((entry) => entry.id === jobId)!;
    return agentJobResult(batch, job, `${job.name} 已保存到 Esse。`);
  });

  registerAppTool(server, "fail_agent_image_job", {
    title: "Fail Agent image job",
    description: "Marks one Codex 生成 job failed. Use when the current Agent lacks image-generation capability or generation failed; state the actual reason instead of leaving the job pending.",
    inputSchema: { batchId: z.string().min(1), jobId: z.string().min(1), error: z.string().min(1).max(2000) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: headlessToolMeta()
  }, async ({ batchId, jobId, error }) => {
    const batch = await options.batches.failAgentJob(batchId, jobId, error);
    const job = batch.jobs.find((entry) => entry.id === jobId)!;
    return agentJobResult(batch, job, `${job.name} 已记录失败：${job.error}`);
  });

  registerAppTool(server, "list_image_batches", {
    title: "List recent local image batches",
    description: "Lists recent Esse batch IDs, titles, image names, IDs, and statuses. Use this when the user refers to an earlier result such as 图1 but its batchId is not already known.",
    inputSchema: { limit: z.number().int().min(1).max(30).default(10) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: headlessToolMeta()
  }, async ({ limit }) => {
    const batches = options.batches.list(limit);
    const text = batches.length
      ? batches.map((batch) => `${batch.title} (${batch.id}): ${batch.jobs.map((job) => `${job.name}=${job.id} [${job.status}]`).join(", ")}`).join("\n")
      : "No local image batches exist yet.";
    return { structuredContent: { batches }, content: [{ type: "text" as const, text }] };
  });

  registerAppTool(server, "get_image_batch", {
    title: "Get local image batch",
    description: "Gets current persistent batch status and local output paths.",
    inputSchema: { batchId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["model", "app"] } }
  }, async ({ batchId }) => batchResult(options.batches.get(batchId)));

  registerAppTool(server, "render_image_batch", {
    title: "Render local image batch",
    description: "Returns an existing local image batch without opening a duplicate inline workbench. An already docked esse sidebar refreshes itself.",
    inputSchema: { batchId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: headlessToolMeta()
  }, async ({ batchId }) => batchResult(options.batches.get(batchId)));

  registerAppTool(server, "modify_selected_images", {
    title: "Modify selected local images",
    description: "Modifies completed job IDs inside their existing batch. Each previous result is preserved as 图1-1, 图1-2, and so on. Uses offeringId when the user explicitly selects a model; otherwise reuses the batch offering.",
    inputSchema: {
      batchId: z.string().min(1),
      jobIds: z.array(z.string()).min(1).max(50),
      instructions: z.string().min(1).max(5000),
      offeringId: z.string().optional(),
      outputDirectory: z.string().optional(),
      requestKey: z.string().max(200).optional()
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    _meta: headlessToolMeta()
  }, async (input) => {
    const batch = await options.batches.modifyInPlace(input);
    const message = batch.jobs.some((job) => input.jobIds.includes(job.id) && job.offering?.adapterId === "agent-generation")
      ? "已建立 Codex 生成修改任务。当前 Agent 必须使用每个 job 返回的参考图完成生成并逐项回传结果。"
      : undefined;
    return batchResult(batch, message);
  });

  registerUiTools(server, options);
  return server;
}

function registerUiTools(server: McpServer, options: Parameters<typeof createLocalEsseServer>[0]): void {
  const appOnly = { ui: { visibility: ["app"] as Array<"app"> } };

  registerAppTool(server, "ui_get_local_state", {
    title: "Get local workbench state",
    description: "Widget-only local state refresh.",
    inputSchema: { batchId: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: appOnly
  }, async ({ batchId }) => appResult(await uiState(options, "batches", batchId)));

  registerAppTool(server, "ui_get_batch_state", {
    title: "Get one local batch state",
    description: "Widget-only lightweight refresh for the currently selected batch.",
    inputSchema: { batchId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: appOnly
  }, async ({ batchId }) => batchResult(options.batches.get(batchId)));

  registerAppTool(server, "ui_open_batch_folder", {
    title: "Open batch output folder",
    description: "Widget-only request to open the current batch output directory in Finder or File Explorer.",
    inputSchema: { batchId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: appOnly
  }, async ({ batchId }) => {
    const batch = options.batches.get(batchId);
    await (options.openFolder || openLocalFolder)(batch.outputDirectory);
    return { structuredContent: { opened: true, path: batch.outputDirectory }, content: [{ type: "text", text: "Batch output folder opened." }] };
  });

  registerAppTool(server, "ui_list_image_batches", {
    title: "Browse local image batches",
    description: "Widget-only paginated batch library ordered by recent activity.",
    inputSchema: {
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(4).max(20).default(8)
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: appOnly
  }, async ({ page, pageSize }) => {
    const result = options.batches.listPage(page, pageSize);
    return {
      structuredContent: result,
      content: [{ type: "text", text: `Loaded batch page ${result.page} of ${result.totalPages}.` }]
    };
  });

  registerAppTool(server, "ui_save_provider_profile", {
    title: "Save local provider profile",
    description: "Widget-only provider settings. API keys go directly to local secure storage and are never returned.",
    inputSchema: {
      id: z.string().optional(),
      displayName: z.string().min(1).max(100),
      tierName: z.string().min(1).max(100),
      baseUrl: z.string().url(),
      adapterId: z.enum(["tuzi-json-images", "openai-images"]),
      concurrency: z.number().int().min(1).max(12),
      apiKey: z.string().max(1000).optional(),
      offerings: z.array(offeringInputSchema).min(1).max(50)
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: appOnly
  }, async (input) => {
    const offerings: OfferingConfig[] = input.offerings.map((offering) => ({ ...offering, id: offering.id || randomUUID() }));
    await options.settings.saveProvider({ ...input, adapterId: input.adapterId as AdapterId, offerings });
    return appResult(await uiState(options, "settings"));
  });

  registerAppTool(server, "ui_delete_provider_profile", {
    title: "Delete local provider profile",
    description: "Widget-only provider deletion from settings and secure storage.",
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    _meta: appOnly
  }, async ({ id }) => {
    await options.settings.deleteProvider(id);
    return appResult(await uiState(options, "settings"));
  });

  registerAppTool(server, "ui_test_provider_profile", {
    title: "Test local provider profile",
    description: "Widget-only provider connection test and model discovery.",
    inputSchema: { baseUrl: z.string().url(), profileId: z.string().optional(), apiKey: z.string().max(1000).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    _meta: appOnly
  }, async (input) => {
    const tested = await options.registry.testProfile(input);
    return { structuredContent: { ok: true, modelCount: tested.models.length }, content: [{ type: "text", text: "Provider connection succeeded." }], _meta: { models: tested.models } };
  });

  registerAppTool(server, "ui_set_default_offering", {
    title: "Set default local offering",
    description: "Widget-only default offering selection.",
    inputSchema: { offeringId: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: appOnly
  }, async ({ offeringId }) => {
    await options.settings.setDefaultOffering(offeringId);
    return appResult(await uiState(options, "settings"));
  });

  registerAppTool(server, "ui_get_image_preview", {
    title: "Get local image preview",
    description: "Widget-only image preview bytes. Image data is not exposed to the model.",
    inputSchema: { batchId: z.string().min(1), jobId: z.string().min(1), full: z.boolean().default(false), sourceIndex: z.number().int().min(0).max(19).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: appOnly
  }, async ({ batchId, jobId, full, sourceIndex }) => {
    const batch = options.batches.get(batchId);
    const job = batch.jobs.find((entry) => entry.id === jobId);
    const backup = batch.jobs.flatMap((entry) => entry.backups || []).find((entry) => entry.id === jobId);
    const sourcePaths = job ? previewSourcePaths(job) : backup?.referenceImagePaths || [];
    const filePath = sourceIndex === undefined ? backup?.outputPath || job?.outputPath || sourcePaths[0] : sourcePaths[sourceIndex];
    if (!filePath) throw new Error("This image has no local file to preview.");
    const dataUrl = full ? await fileDataUrl(filePath).catch(() => options.thumbnailer.dataUrl(filePath, 1600)) : await options.thumbnailer.dataUrl(filePath, 640);
    if (!dataUrl) throw new Error("Could not create a local preview.");
    return { structuredContent: { batchId, jobId, sourceIndex, available: true }, content: [{ type: "text", text: "Local image preview ready." }], _meta: { dataUrl } };
  });

  registerAppTool(server, "ui_save_image_as", {
    title: "Save local image as",
    description: "Widget-only native Save As dialog for a generated image or preserved version.",
    inputSchema: { batchId: z.string().min(1), jobId: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: appOnly
  }, async ({ batchId, jobId }) => {
    const batch = options.batches.get(batchId);
    const job = batch.jobs.find((entry) => entry.id === jobId);
    const backup = batch.jobs.flatMap((entry) => entry.backups || []).find((entry) => entry.id === jobId);
    const filePath = backup?.outputPath || job?.outputPath;
    if (!filePath) throw new Error("This image has no completed local file to save.");
    const extension = path.extname(filePath) || ".png";
    const suggestedName = `${backup?.name || job?.name || path.basename(filePath, extension)}${extension}`;
    const savedPath = await (options.saveFileAs || saveFileAs)(filePath, suggestedName);
    return {
      structuredContent: { saved: Boolean(savedPath), canceled: !savedPath, path: savedPath },
      content: [{ type: "text", text: savedPath ? `Image saved to ${savedPath}` : "Image save canceled." }]
    };
  });

  registerAppTool(server, "ui_cancel_queued_jobs", {
    title: "Cancel local queued jobs",
    description: "Widget-only cancellation for jobs not yet sent to a provider.",
    inputSchema: { batchId: z.string().min(1), jobIds: z.array(z.string()).max(50).optional() },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: appOnly
  }, async ({ batchId, jobIds }) => batchResult(await options.batches.cancelQueued(batchId, jobIds)));

  registerAppTool(server, "ui_retry_jobs", {
    title: "Retry local image jobs",
    description: "Widget-only retry. Clicking the retry control is the user's explicit retry action, including when the previous charge state is unknown.",
    inputSchema: { batchId: z.string().min(1), jobIds: z.array(z.string()).min(1).max(50), allowUnknownCharge: z.boolean().default(false) },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    _meta: appOnly
  }, async ({ batchId, jobIds, allowUnknownCharge }) => batchResult(await options.batches.retry(batchId, jobIds, allowUnknownCharge)));

  registerAppTool(server, "ui_delete_image_batch", {
    title: "Delete local image batch",
    description: "Widget-only batch deletion. Removes the batch record and every generated or backup image managed by that batch.",
    inputSchema: { batchId: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    _meta: appOnly
  }, async ({ batchId }) => {
    await options.batches.delete(batchId);
    return appResult(await uiState(options, "batches"));
  });
}

async function uiState(options: Parameters<typeof createLocalEsseServer>[0], tab: "batches" | "settings", batchId?: string) {
  const [settings, providers, offerings] = await Promise.all([
    options.settings.load(),
    options.settings.listProfiles(),
    options.registry.listOfferings()
  ]);
  return {
    view: { tab, batchId },
    providers,
    offerings,
    defaultOfferingId: settings.defaultOfferingId,
    batches: options.batches.listRecent(8),
    activeBatch: batchId ? options.batches.get(batchId) : undefined,
    platform: process.platform,
    secureStorage: process.platform === "win32" ? "Windows DPAPI" : process.platform === "darwin" ? "macOS Keychain" : "Unavailable"
  };
}

function widgetToolMeta(invoking: string, invoked: string) {
  return {
    ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] as Array<"model" | "app"> },
    "openai/outputTemplate": WIDGET_URI,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked
  };
}

function headlessToolMeta() {
  return { ui: { visibility: ["model", "app"] as Array<"model" | "app"> } };
}

function previewSourcePaths(job: JobRecord): string[] {
  if (job.referenceImagePaths?.length) return [...new Set(job.referenceImagePaths)];
  if (job.generationInputPaths?.length) return [...new Set(job.generationInputPaths)];
  if (job.generationInputPath) return [job.generationInputPath];
  if (job.inputPaths?.length) return [...new Set(job.inputPaths)];
  return job.inputPath ? [job.inputPath] : [];
}

function resolveExistingImagePaths(
  batches: BatchManager,
  references: Array<{ batchId: string; image: string }> | undefined
): string[] {
  return (references || []).map((reference) => {
    const batch = batches.get(reference.batchId);
    const selector = reference.image.trim();
    const job = batch.jobs.find((entry) => entry.id === selector || entry.name === selector);
    const backup = batch.jobs.flatMap((entry) => entry.backups || []).find((entry) => entry.id === selector || entry.name === selector);
    const outputPath = backup?.outputPath || job?.outputPath || (job?.status === "failed" ? previewSourcePaths(job)[0] : undefined);
    if (!job && !backup) throw new Error(`批次“${batch.title}”中找不到图片“${selector}”。请使用 list_image_batches 返回的准确名称或 ID。`);
    if (!outputPath) throw new Error(`批次“${batch.title}”中的“${selector}”没有可用的完成图或失败任务原图，暂时不能作为参考图。`);
    return outputPath;
  });
}

function appResult(state: unknown) {
  return { structuredContent: { state }, content: [{ type: "text" as const, text: "Local esse state is ready." }] };
}

function batchResult(batch: BatchSnapshot, message?: string, activate = false) {
  return {
    structuredContent: { batch, ...(activate ? { activateBatchId: batch.id } : {}) },
    content: [{ type: "text" as const, text: message || `${batch.title}: ${batch.succeeded}/${batch.total} completed; outputs: ${batch.outputDirectory}` }]
  };
}

function agentJobResult(batch: BatchSnapshot, job: JobRecord, message: string) {
  return {
    structuredContent: {
      batch,
      job: {
        id: job.id,
        name: job.name,
        prompt: job.prompt,
        referenceImagePaths: previewSourcePaths(job),
        outputDirectory: batch.outputDirectory,
        status: job.status
      }
    },
    content: [{ type: "text" as const, text: message }]
  };
}

function splitDataUrl(value: string): { mimeType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  if (!match?.[1] || !match[2]) throw new Error("Invalid local image preview.");
  return { mimeType: match[1], data: match[2] };
}
