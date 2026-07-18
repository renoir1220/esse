import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { BatchManager } from "../jobs/batch-manager.js";
import { scanImageFolder } from "../files/image-files.js";
import { fileDataUrl } from "../files/output-files.js";
import type { Thumbnailer } from "../files/thumbnailer.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SettingsStore } from "../storage/settings-store.js";
import type { AdapterId, BatchSnapshot, OfferingConfig } from "../types.js";

export const WIDGET_URI = "ui://esse/local-v1.html";

const priceSchema = z.object({
  mode: z.enum(["per_request", "token", "unknown"]),
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

export function createLocalEsseServer(options: {
  widgetHtml: string;
  settings: SettingsStore;
  registry: ProviderRegistry;
  batches: BatchManager;
  thumbnailer: Thumbnailer;
}): McpServer {
  const server = new McpServer(
    { name: "esse", version: "0.1.0" },
    {
      instructions:
        "esse runs local parallel image batches. Inspect local folders before image-aware work, create one batch for many images, and keep each offering's provider, credential, price tier, and adapter together. Routine tools are headless so an already docked sidebar keeps its layout. modify_selected_images updates jobs in the same batch and preserves Chinese-named backups."
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
    description: "Lists configured provider profile, credential tier, model, price, adapter, and concurrency combinations. The same model can appear more than once with different API contracts.",
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
    description: "Creates a local persistent batch from a folder, explicit image paths, or text-only generation count. Files are sent to the selected external provider and outputs are saved locally without overwriting sources.",
    inputSchema: {
      title: z.string().max(120).optional(),
      offeringId: z.string().min(1),
      prompt: z.string().min(1).max(5000),
      perImagePrompts: z.record(z.string()).optional(),
      folderPath: z.string().optional(),
      recursive: z.boolean().default(false),
      imagePaths: z.array(z.string()).max(50).optional(),
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
    let imagePaths = input.imagePaths || [];
    if (input.folderPath) {
      const scanned = await scanImageFolder({ folderPath: input.folderPath, recursive: input.recursive, maxImages: input.maxImages });
      imagePaths = [...imagePaths, ...scanned.files.map((file) => file.path)];
    }
    imagePaths = [...new Set(imagePaths)].slice(0, input.maxImages);
    const batch = await options.batches.create({
      title: input.title,
      offeringId: input.offeringId,
      prompt: input.prompt,
      perImagePrompts: input.perImagePrompts,
      imagePaths,
      inputDirectory: input.folderPath,
      outputDirectory: input.outputDirectory,
      count: input.count,
      size: input.size,
      quality: input.quality,
      requestKey: input.requestKey
    });
    return batchResult(batch, `已创建 ${batch.total} 个本地任务，${batch.offering.concurrency} 路并发，结果目录：${batch.outputDirectory}`);
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
    description: "Modifies completed job IDs inside their existing batch. Each previous result is preserved as 图1-1, 图1-2, and so on. Reuses the original exact offering.",
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
  }, async (input) => batchResult(await options.batches.modifyInPlace(input)));

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
      offerings: z.array(offeringInputSchema).min(1).max(50),
      makeDefault: z.boolean().default(false)
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
    inputSchema: { batchId: z.string().min(1), jobId: z.string().min(1), full: z.boolean().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: appOnly
  }, async ({ batchId, jobId, full }) => {
    const batch = options.batches.get(batchId);
    const job = batch.jobs.find((entry) => entry.id === jobId);
    const backup = batch.jobs.flatMap((entry) => entry.backups || []).find((entry) => entry.id === jobId);
    const filePath = backup?.outputPath || job?.outputPath || job?.inputPath;
    if (!filePath) throw new Error("This image has no local file to preview.");
    const dataUrl = full ? await fileDataUrl(filePath).catch(() => options.thumbnailer.dataUrl(filePath, 1600)) : await options.thumbnailer.dataUrl(filePath, 640);
    if (!dataUrl) throw new Error("Could not create a local preview.");
    return { structuredContent: { batchId, jobId, available: true }, content: [{ type: "text", text: "Local image preview ready." }], _meta: { dataUrl } };
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
    description: "Widget-only retry. Unknown-charge jobs stay blocked unless the user explicitly confirms the billing risk.",
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
    batches: options.batches.list(30),
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

function appResult(state: unknown) {
  return { structuredContent: { state }, content: [{ type: "text" as const, text: "Local esse state is ready." }] };
}

function batchResult(batch: BatchSnapshot, message?: string) {
  return {
    structuredContent: { batch },
    content: [{ type: "text" as const, text: message || `${batch.title}: ${batch.succeeded}/${batch.total} completed; outputs: ${batch.outputDirectory}` }]
  };
}

function splitDataUrl(value: string): { mimeType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  if (!match?.[1] || !match[2]) throw new Error("Invalid local image preview.");
  return { mimeType: match[1], data: match[2] };
}
