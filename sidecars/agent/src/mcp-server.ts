import { createHash, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Express, NextFunction, Request, Response } from 'express';
import type { BatchManager } from './batch-manager';
import { DESKTOP_BATCH_SKILL } from './desktop-skill';
import type { ImageStore } from './image-store';
import type { BatchJobInput, BatchSnapshot, OfferingSummary } from './types';

const MCP_HOST = '127.0.0.1';
export const DEFAULT_MCP_PORT = 43181;
const MAX_REFERENCE_IMAGES = 20;

type McpBatchManager = Pick<BatchManager,
  'offerings' | 'create' | 'append' | 'modify' | 'list' | 'get' | 'activate' | 'merge'
  | 'deleteImages' | 'startAgentJob' | 'completeAgentJob' | 'failAgentJob' | 'inspectFolder'>;

interface DesktopMcpServerOptions {
  pairingToken: string;
  port?: number;
  batchManager: McpBatchManager;
  imageStore: Pick<ImageStore, 'get' | 'importFile' | 'pathForId'>;
  createImagePreview?: (filePath: string, maxDimension: number) => Promise<{ data: string; mimeType: string } | undefined>;
  onOpenRequested?: (input: { tab: 'batches' | 'settings'; batchId?: string }) => void | Promise<void>;
}

export interface RunningDesktopMcpServer {
  endpoint: string;
  stop(): Promise<void>;
}

const existingReferenceSchema = z.object({
  batchId: z.string().uuid(),
  image: z.string().trim().min(1).max(200),
});

const jobSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  referenceImageIds: z.array(z.string().uuid()).max(MAX_REFERENCE_IMAGES).optional(),
  referenceImagePaths: z.array(z.string().trim().min(1)).max(MAX_REFERENCE_IMAGES).optional(),
  referenceImages: z.array(existingReferenceSchema).max(MAX_REFERENCE_IMAGES).optional(),
});

export async function startDesktopMcpServer(options: DesktopMcpServerOptions): Promise<RunningDesktopMcpServer> {
  const app = createMcpExpressApp({ host: MCP_HOST, allowedHosts: [MCP_HOST, 'localhost'] });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const origin = request.header('origin');
    if (origin && origin !== `http://${request.header('host')}`) {
      response.status(403).json({ error: 'Origin is not allowed.' });
      return;
    }
    const supplied = request.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!supplied || !tokensEqual(supplied, options.pairingToken)) {
      response.setHeader('www-authenticate', 'Bearer realm="Esse"');
      response.status(401).json({ error: 'Invalid Esse pairing token.' });
      return;
    }
    next();
  });

  app.post('/mcp', async (request: Request, response: Response) => {
    const server = createServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      console.error('Esse MCP request failed', safeMessage(error));
      if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal MCP error.' }, id: null });
    }
  });
  app.get('/mcp', (_request: Request, response: Response) => methodNotAllowed(response));
  app.delete('/mcp', (_request: Request, response: Response) => methodNotAllowed(response));

  const httpServer = await listen(app, options.port ?? DEFAULT_MCP_PORT);
  const address = httpServer.address() as AddressInfo;
  return {
    endpoint: `http://${MCP_HOST}:${address.port}/mcp`,
    stop: () => closeServer(httpServer),
  };
}

function createServer(options: DesktopMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'esse', version: '0.3.0' },
    {
      instructions: DESKTOP_BATCH_SKILL,
    },
  );

  server.registerPrompt('batch-generate-images', {
    title: 'Use Esse for a durable image batch',
    description: 'Provider-neutral Esse workflow: submit fully specified image work without extra capability warnings, then stop after background acceptance.',
  }, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: DESKTOP_BATCH_SKILL } }] }));

  server.registerTool('open_esse', {
    title: 'Open Esse',
    description: '打开或聚焦 Esse 的任务或设置页面。仅在用户要查看 Esse 时使用。',
    inputSchema: {
      tab: z.enum(['batches', 'settings']).default('batches'),
      batchId: z.string().uuid().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ tab, batchId }) => toolResult(async () => {
    if (batchId) await options.batchManager.activate(batchId);
    await options.onOpenRequested?.({ tab, batchId });
    return { opened: true, tab, batchId };
  }));

  server.registerTool('list_image_offerings', {
    title: 'List Esse image offerings',
    description: '仅当用户主动询问模型或价格时，列出 Esse 当前配置。普通生成不要调用或复述金额。',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => toolResult(async () => {
    const offerings = await options.batchManager.offerings();
    return {
      offerings: offerings.map((offering) => ({
        ...offering,
        adapterId: offering.providerType,
        estimatedPricePerImage: formatCny(offering.priceMicros),
      })),
      conversationPolicy: 'Only discuss model, Provider, and price details when the user explicitly asks. Ordinary generation proceeds silently through the configured Esse Provider.',
    };
  }));

  server.registerTool('inspect_image_folder', {
    title: 'Inspect a local image folder',
    description: '在依赖本地图片内容的批次前，分页列出文件夹中的真实图片文件。',
    inputSchema: {
      folderPath: z.string().trim().min(1).optional(),
      directory: z.string().trim().min(1).optional().describe('Deprecated alias for folderPath.'),
      recursive: z.boolean().default(false),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(12).default(8),
      offset: z.number().int().min(0).optional().describe('Deprecated offset pagination.'),
      limit: z.number().int().min(1).max(50).optional().describe('Deprecated offset page size.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ folderPath, directory, recursive, page, pageSize, offset, limit }) => {
    try {
      const selectedPath = folderPath || directory;
      if (!selectedPath) throw new Error('Provide folderPath.');
      const allImages = await options.batchManager.inspectFolder(selectedPath, recursive, 500);
      const start = offset ?? ((page - 1) * pageSize);
      const take = limit ?? pageSize;
      const images = allImages.slice(start, start + take);
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{
        type: 'text',
        text: `Folder: ${path.resolve(selectedPath)}\nImages: ${allImages.length}${allImages.length >= 500 ? '+' : ''}\nShowing ${images.length ? start + 1 : 0}-${start + images.length}. Exact local paths and thumbnails follow.`,
      }];
      for (const [index, image] of images.entries()) {
        content.push({ type: 'text', text: `Image ${start + index + 1}: ${image.path}` });
        const preview = await options.createImagePreview?.(image.path, 960);
        if (preview) content.push({ type: 'image', ...preview });
        else content.push({ type: 'text', text: 'Preview unavailable; use the filename and exact path only.' });
      }
      return {
        content,
        structuredContent: {
          folderPath: path.resolve(selectedPath),
          files: images,
          page: offset === undefined ? page : Math.floor(start / take) + 1,
          pageSize: take,
          total: allImages.length,
          hasMore: start + images.length < allImages.length,
          truncated: allImages.length >= 500,
        },
      };
    } catch (error) {
      const message = safeMessage(error);
      return { isError: true, content: [{ type: 'text' as const, text: message }], structuredContent: { error: message } };
    }
  });

  server.registerTool('create_image_batch', {
    title: 'Create an Esse image batch',
    description: 'Esse 是调用用户已配置 Provider/模型的本地图片任务工作台，不是某种图像模型或模型架构。用户点名用 Esse 且任务信息充分时直接派工；不要因文字、数字、图表或你推测的模型能力而二次确认。持久化后立即返回；收到 execution=background 后回复 message 并立即结束当前任务，不得等待、轮询或调用其他 Esse 工具。',
    inputSchema: {
      title: z.string().trim().min(1).max(160).optional(),
      offeringId: z.string().trim().min(1).max(200).optional(),
      prompt: z.string().trim().min(1).max(20_000).optional(),
      perImagePrompts: z.record(z.string(), z.string().trim().min(1).max(20_000)).optional(),
      folderPath: z.string().trim().min(1).optional(),
      recursive: z.boolean().default(false),
      imagePaths: z.array(z.string().trim().min(1)).max(50).optional(),
      maxImages: z.number().int().min(1).max(50).default(50),
      count: z.number().int().min(1).max(50).optional(),
      jobs: z.array(jobSchema).min(1).max(50).optional(),
      referenceImageIds: z.array(z.string().uuid()).max(MAX_REFERENCE_IMAGES).optional(),
      referenceImagePaths: z.array(z.string().trim().min(1)).max(MAX_REFERENCE_IMAGES).optional(),
      referenceImages: z.array(existingReferenceSchema).max(MAX_REFERENCE_IMAGES).optional(),
      size: z.string().trim().min(1).max(50).optional(),
      quality: z.string().trim().min(1).max(50).optional(),
      approvedEstimatedCostMicros: z.number().int().nonnegative().optional().describe('Legacy compatibility only. Omit for normal requests; Esse uses the configured Provider price internally.'),
      requestKey: requestKeySchema(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => toolResult(async () => {
    if (!args.prompt && !args.jobs?.length) throw new Error('Provide prompt or at least one jobs[] item with its own prompt.');
    const inspectedPaths = args.folderPath
      ? (await options.batchManager.inspectFolder(args.folderPath, args.recursive, args.maxImages)).map((image) => image.path)
      : [];
    const imagePaths = unique([...(args.imagePaths ?? []).map((value) => path.resolve(value)), ...inspectedPaths]).slice(0, args.maxImages);
    const topReferences = await materializeReferences(options, args.requestKey, {
      referenceImageIds: args.referenceImageIds,
      referenceImagePaths: args.referenceImagePaths,
      referenceImages: args.referenceImages,
    });
    const jobCount = args.jobs?.length || imagePaths.length;
    const jobs = jobCount
      ? await Promise.all(Array.from({ length: jobCount }, async (_, index) => {
        const job = args.jobs?.[index];
        const imagePath = imagePaths[index];
        const alignedReferences = imagePath
          ? await materializeReferences(options, args.requestKey, { referenceImagePaths: [imagePath] }, index)
          : [];
        return {
          prompt: job?.prompt || promptForImage(args.prompt!, args.perImagePrompts, imagePath, index),
          referenceImageIds: unique([
            ...alignedReferences,
            ...topReferences,
            ...(job ? await materializeReferences(options, args.requestKey, job, index) : []),
          ]),
        };
      }))
      : undefined;
    const batch = await options.batchManager.create({
      title: args.title,
      offeringId: args.offeringId,
      prompt: args.prompt,
      count: args.count,
      jobs,
      size: args.size,
      quality: args.quality,
      approvedEstimatedCostMicros: args.approvedEstimatedCostMicros,
      requestKey: args.requestKey,
    });
    return accepted(batch);
  }));

  server.registerTool('append_image_batch_jobs', {
    title: 'Append jobs to an Esse batch',
    description: '向现有批次原位追加图片任务并立即返回。不要新建临时批次或用合并模拟追加。收到 execution=background 后回复 message 并立即结束当前任务，不得等待、轮询或查询完成情况。',
    inputSchema: {
      batchId: z.string().uuid(),
      offeringId: z.string().trim().min(1).max(200).optional(),
      prompt: z.string().trim().min(1).max(20_000).optional(),
      count: z.number().int().min(1).max(50).optional(),
      jobs: z.array(jobSchema).min(1).max(50).optional(),
      referenceImageIds: z.array(z.string().uuid()).max(MAX_REFERENCE_IMAGES).optional(),
      referenceImagePaths: z.array(z.string().trim().min(1)).max(MAX_REFERENCE_IMAGES).optional(),
      referenceImages: z.array(existingReferenceSchema).max(MAX_REFERENCE_IMAGES).optional(),
      size: z.string().trim().min(1).max(50).optional(),
      quality: z.string().trim().min(1).max(50).optional(),
      approvedEstimatedCostMicros: z.number().int().nonnegative().optional().describe('Legacy compatibility only. Omit for normal requests; Esse uses the configured Provider price internally.'),
      requestKey: requestKeySchema(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => toolResult(async () => {
    if (!args.prompt && !args.jobs?.length) throw new Error('Provide prompt or at least one jobs[] item with its own prompt.');
    const sharedReferences = await materializeReferences(options, args.requestKey, args);
    const count = args.jobs?.length || args.count || 1;
    const jobs = await Promise.all(Array.from({ length: count }, async (_, index): Promise<BatchJobInput> => ({
      prompt: args.jobs?.[index]?.prompt || args.prompt!,
      referenceImageIds: unique([
        ...sharedReferences,
        ...(args.jobs?.[index] ? await materializeReferences(options, args.requestKey, args.jobs[index], index) : []),
      ]),
    })));
    const result = await options.batchManager.append({
      batchId: args.batchId,
      offeringId: args.offeringId,
      jobs,
      size: args.size,
      quality: args.quality,
      approvedEstimatedCostMicros: args.approvedEstimatedCostMicros,
      requestKey: args.requestKey,
    });
    const response = accepted(result.batch);
    return response.execution === 'current-agent'
      ? { ...response, appendedJobIds: result.appendedJobIds }
      : response;
  }));

  server.registerTool('modify_selected_images', {
    title: 'Modify exact images in an Esse batch',
    description: '用准确的当前图片或备份 image ID 在同一批次内修改；当前版本会保留为图1-1等备份。用户粘贴或附加的图片必须通过 referenceImagePaths 作为额外参考图传入，不能只写进提示词。任务持久化后立即返回；收到 execution=background 后回复 message 并立即结束当前任务，不得等待、轮询或查询完成情况。',
    inputSchema: {
      batchId: z.string().uuid(),
      imageIds: z.array(z.string().uuid()).min(1).max(50).optional(),
      jobIds: z.array(z.string().uuid()).min(1).max(50).optional().describe('Deprecated alias for imageIds.'),
      referenceImageIds: z.array(z.string().uuid()).max(MAX_REFERENCE_IMAGES - 1).optional().describe('Additional Esse-local reference image IDs, separate from the exact modification targets. The target itself occupies one of the 20 reference slots.'),
      referenceImagePaths: z.array(z.string().trim().min(1)).max(MAX_REFERENCE_IMAGES - 1).optional().describe('Absolute local paths for pasted, attached, or other external reference images. Pass the real attachment here; prompt text alone is not an image reference. The target itself occupies one of the 20 reference slots.'),
      referenceImages: z.array(existingReferenceSchema).max(MAX_REFERENCE_IMAGES - 1).optional().describe('Additional existing Esse results resolved by batch and exact image name or ID. The target itself occupies one of the 20 reference slots.'),
      prompt: z.string().trim().min(1).max(20_000).optional(),
      instructions: z.string().trim().min(1).max(20_000).optional(),
      offeringId: z.string().trim().min(1).max(200).optional(),
      size: z.string().trim().min(1).max(50).optional(),
      quality: z.string().trim().min(1).max(50).optional(),
      approvedEstimatedCostMicros: z.number().int().nonnegative().optional().describe('Legacy compatibility only. Omit for normal requests; Esse uses the configured Provider price internally.'),
      requestKey: requestKeySchema(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => toolResult(async () => {
    const imageIds = args.imageIds || args.jobIds;
    const prompt = args.instructions || args.prompt;
    if (!imageIds?.length) throw new Error('Provide at least one exact image ID.');
    if (!prompt) throw new Error('Provide instructions or prompt.');
    const requestedReferenceCount = unique([
      ...(args.referenceImageIds ?? []),
      ...(args.referenceImagePaths ?? []).map((value) => path.resolve(value)),
      ...(args.referenceImages ?? []).map((value) => `${value.batchId}:${value.image}`),
    ]).length;
    if (requestedReferenceCount > MAX_REFERENCE_IMAGES - 1) throw new Error(`A modification may include at most ${MAX_REFERENCE_IMAGES - 1} additional references because the target image also occupies one reference slot.`);
    const additionalReferenceImageIds = await materializeReferences(options, args.requestKey, {
      referenceImageIds: args.referenceImageIds,
      referenceImagePaths: args.referenceImagePaths,
      referenceImages: args.referenceImages,
    });
    const result = await options.batchManager.modify({
      batchId: args.batchId,
      imageIds,
      referenceImageIds: additionalReferenceImageIds,
      prompt,
      offeringId: args.offeringId,
      size: args.size,
      quality: args.quality,
      approvedEstimatedCostMicros: args.approvedEstimatedCostMicros,
      requestKey: args.requestKey,
    });
    const response = accepted(result.batch);
    return response.execution === 'current-agent'
      ? { ...response, modifiedJobIds: result.modifiedJobIds }
      : response;
  }));

  server.registerTool('list_image_batches', {
    title: 'List Esse image batches',
    description: '仅在用户另行明确要求查找历史批次、查询状态或引用既有结果时调用。刚刚成功派工不等于用户要求跟踪；派工后不得主动调用它等待完成、取回、复制或展示产物。',
    inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit }) => toolResult(async () => ({
    batches: await Promise.all(options.batchManager.list().slice(0, limit).map((batch) => enrichBatch(options, batch))),
  })));

  server.registerTool('get_image_batch', {
    title: 'Get an Esse image batch',
    description: '仅在用户另行明确查询状态/详情或需要引用既有结果时，获取批次、图片 ID、路径和进度。刚刚成功派工不等于用户要求跟踪；不得主动轮询，也不得因此把产物复制或展示到 Agent 对话。',
    inputSchema: { batchId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ batchId }) => toolResult(async () => ({ batch: await enrichBatch(options, options.batchManager.get(batchId)) })));

  server.registerTool('render_image_batch', {
    title: 'Show an Esse image batch',
    description: '仅在用户另行明确要求查看时，在 Esse 内激活指定批次；派工成功后不要主动调用，也不要把图片取回或展示到 Agent 对话。',
    inputSchema: { batchId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ batchId }) => toolResult(async () => {
    const batch = await options.batchManager.activate(batchId);
    return { batch: await enrichBatch(options, batch), activated: true };
  }));

  server.registerTool('delete_esse_images', {
    title: 'Delete exact Esse images',
    description: '仅在用户明确要求时，按准确 image ID 删除当前图片或备份。文件移入 Esse 本地可恢复区。',
    inputSchema: { batchId: z.string().uuid(), imageIds: z.array(z.string().uuid()).min(1).max(50) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ batchId, imageIds }) => toolResult(async () => ({ batch: await enrichBatch(options, await options.batchManager.deleteImages(batchId, imageIds)) })));

  server.registerTool('merge_image_batches', {
    title: 'Merge terminal Esse batches',
    description: '把不同的已结束批次合并到目标批次；默认保留源批次。追加图片不得使用此工具。',
    inputSchema: {
      targetBatchId: z.string().uuid(),
      sourceBatchIds: z.array(z.string().uuid()).min(1).max(49),
      deleteSourceBatches: z.boolean().default(false),
      requestKey: requestKeySchema(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => toolResult(async () => ({ batch: await enrichBatch(options, await options.batchManager.merge(args)) })));

  server.registerTool('start_agent_image_job', {
    title: 'Start an Agent-owned Esse image job',
    description: '仅用于 offering adapterId 为 agent-generation 的队列任务。Provider 模型任务由 Esse 自己执行。',
    inputSchema: { batchId: z.string().uuid(), jobId: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ batchId, jobId }) => toolResult(async () => {
    const job = await options.batchManager.startAgentJob(batchId, jobId);
    return {
      batch: await enrichBatch(options, options.batchManager.get(batchId)),
      job: await agentJobDescriptor(options, job),
    };
  }));

  server.registerTool('complete_agent_image_job', {
    title: 'Complete an Agent-owned Esse image job',
    description: '用真实的本地图片绝对路径完成一个已开始的 agent-generation 任务。',
    inputSchema: {
      batchId: z.string().uuid(),
      jobId: z.string().uuid(),
      imagePath: z.string().trim().min(1).optional(),
      outputPath: z.string().trim().min(1).optional().describe('Deprecated alias for imagePath.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ batchId, jobId, imagePath, outputPath }) => toolResult(async () => {
    const selectedPath = imagePath || outputPath;
    if (!selectedPath) throw new Error('Provide imagePath.');
    const batch = await options.batchManager.completeAgentJob(batchId, jobId, selectedPath);
    return { batch: await enrichBatch(options, batch), job: await agentJobDescriptor(options, batch.jobs.find((job) => job.id === jobId)!) };
  }));

  server.registerTool('fail_agent_image_job', {
    title: 'Fail an Agent-owned Esse image job',
    description: '以真实原因结束无法完成的 agent-generation 任务，避免任务永久悬挂。',
    inputSchema: {
      batchId: z.string().uuid(),
      jobId: z.string().uuid(),
      error: z.string().trim().min(1).max(2000).optional(),
      reason: z.string().trim().min(1).max(2000).optional().describe('Deprecated alias for error.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ batchId, jobId, error, reason }) => toolResult(async () => {
    const message = error || reason;
    if (!message) throw new Error('Provide error.');
    const batch = await options.batchManager.failAgentJob(batchId, jobId, message);
    return { batch: await enrichBatch(options, batch), job: await agentJobDescriptor(options, batch.jobs.find((job) => job.id === jobId)!) };
  }));

  // Compatibility aliases for the first WorkBuddy prototype. They now share the durable batch path.
  server.registerTool('get_image_generation_capabilities', {
    title: 'Get Esse image generation capabilities',
    description: 'Compatibility alias for list_image_offerings. Use only when the user explicitly asks about models or prices.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => toolResult(async () => {
    const offerings = await options.batchManager.offerings();
    return {
      models: offerings.map(offeringQuote),
      useInstead: 'Use create_image_batch for new work.',
      conversationPolicy: 'Do not narrate model, Provider, price, or tool details unless the user explicitly asks.',
    };
  }));

  server.registerTool('generate_image', {
    title: 'Generate images with Esse (compatibility)',
    description: '兼容入口：Esse 是调用用户已配置 Provider/模型的本地图片任务工作台，不是某种图像模型。任务信息充分时直接派工，不要基于推测的模型能力二次确认。收到 execution=background 后回复 message 并立即结束当前任务，不得等待、轮询或查询完成情况。优先使用 create_image_batch。',
    inputSchema: {
      prompt: z.string().trim().min(1).max(20_000),
      model: z.string().trim().min(1).max(200).optional(),
      size: z.string().trim().min(1).max(50).default('1024x1024'),
      count: z.number().int().min(1).max(4).default(1),
      approvedEstimatedCostMicros: z.number().int().nonnegative().optional().describe('Legacy compatibility only. Omit for normal requests; Esse uses the configured Provider price internally.'),
      requestKey: requestKeySchema(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ prompt, model, size, count, approvedEstimatedCostMicros, requestKey }) => toolResult(async () => accepted(await options.batchManager.create({
    prompt, offeringId: model, size, count, approvedEstimatedCostMicros, requestKey,
  }))));

  return server;
}

async function materializeReferences(
  options: DesktopMcpServerOptions,
  requestKey: string,
  input: {
    referenceImageIds?: string[];
    referenceImagePaths?: string[];
    referenceImages?: Array<{ batchId: string; image: string }>;
  },
  jobIndex = -1,
): Promise<string[]> {
  const ids = [...(input.referenceImageIds ?? [])];
  for (const id of input.referenceImageIds ?? []) {
    if (!await options.imageStore.get(id)) throw new Error(`Reference image ${id} was not found.`);
  }
  for (const reference of input.referenceImages ?? []) ids.push(resolveExistingReference(options.batchManager.get(reference.batchId), reference.image));
  for (const [index, sourcePath] of (input.referenceImagePaths ?? []).entries()) {
    const fullPath = path.resolve(sourcePath);
    const details = await stat(fullPath);
    if (!details.isFile()) throw new Error(`Reference is not a file: ${fullPath}`);
    const imported = await options.imageStore.importFile({
      sourcePath: fullPath,
      requestId: `reference-${createHash('sha256').update(`${requestKey}:${jobIndex}:${index}:${fullPath}`).digest('hex')}`,
      prompt: 'Esse reference image',
      model: 'local-reference',
      hidden: true,
    });
    ids.push(imported.id);
  }
  return unique(ids);
}

function resolveExistingReference(batch: BatchSnapshot, nameOrId: string): string {
  for (const job of batch.jobs) {
    if (job.id === nameOrId || job.name === nameOrId || job.outputImageId === nameOrId) {
      if (!job.outputImageId) throw new Error(`${job.name} has no current image.`);
      return job.outputImageId;
    }
    const backup = job.backups.find((item) => item.id === nameOrId || item.name === nameOrId || item.imageId === nameOrId);
    if (backup) return backup.imageId;
  }
  throw new Error(`Image ${nameOrId} was not found in batch ${batch.id}.`);
}

async function enrichBatch(options: DesktopMcpServerOptions, batch: BatchSnapshot) {
  const images = [];
  for (const job of batch.jobs) {
    if (job.outputImageId) images.push(await imageDescriptor(options, job.outputImageId, job.name, job.status));
    else if (job.status === 'failed') {
      for (const referenceImageId of job.referenceImageIds) {
        const source = await options.imageStore.get(referenceImageId);
        if (source) images.push(await imageDescriptor(options, referenceImageId, `${job.name} 原输入`, 'failed-source'));
      }
    }
    for (const backup of job.backups) images.push(await imageDescriptor(options, backup.imageId, backup.name, 'backup'));
  }
  return { ...batch, images };
}

async function imageDescriptor(options: DesktopMcpServerOptions, id: string, name: string, status: string) {
  const image = await options.imageStore.get(id);
  return {
    id,
    name,
    status,
    fileName: image?.fileName,
    sourceFileName: image?.sourceFileName,
    path: image ? await options.imageStore.pathForId(id) : undefined,
  };
}

function accepted(batch: BatchSnapshot) {
  const agentOwned = batch.jobs.some((job) => job.status === 'queued' && job.operation === 'agent');
  if (!agentOwned) {
    return {
      accepted: true,
      execution: 'background',
      message: '已交给 Esse 后台生成。',
      nextAction: 'Reply exactly with message, then end the current task. Do not call another Esse tool unless the user sends a new explicit request.',
    } as const;
  }
  return {
    accepted: true,
    execution: 'current-agent',
    message: 'Esse accepted Agent-owned jobs. The current Agent must start each queued job, generate from its exact prompt and referenceImagePaths, then complete or fail it.',
    batch: {
      id: batch.id,
      title: batch.title,
      status: batch.status,
      total: batch.total,
      queued: batch.queued,
      running: batch.running,
      succeeded: batch.succeeded,
      failed: batch.failed,
      canceled: batch.canceled,
      jobs: batch.jobs.map((job) => ({ id: job.id, name: job.name, status: job.status, operation: job.operation })),
    },
  } as const;
}

async function agentJobDescriptor(options: DesktopMcpServerOptions, job: BatchSnapshot['jobs'][number]) {
  return {
    ...job,
    referenceImagePaths: await Promise.all(job.referenceImageIds.map((id) => options.imageStore.pathForId(id))),
  };
}

function promptForImage(prompt: string, perImagePrompts: Record<string, string> | undefined, imagePath: string | undefined, index: number): string {
  const prompts = perImagePrompts ?? {};
  return prompts[imagePath || '']
    || prompts[imagePath ? path.basename(imagePath) : '']
    || prompts[String(index + 1)]
    || prompts[String(index)]
    || prompt;
}

function offeringQuote(offering: OfferingSummary) {
  return {
    id: offering.id,
    provider: offering.providerName,
    providerType: offering.providerType,
    costPerImageMicros: offering.priceMicros,
    estimatedPricePerImageCny: formatCny(offering.priceMicros),
    currency: offering.currency,
  };
}

function requestKeySchema() {
  return z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/).describe('Stable idempotency key; reuse only for the same logical operation.');
}

async function toolResult(action: () => Promise<Record<string, unknown>>) {
  try {
    const structuredContent = await action();
    return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  } catch (error) {
    const message = safeMessage(error);
    return { isError: true, content: [{ type: 'text' as const, text: message }], structuredContent: { error: message } };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatCny(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected Esse error.';
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function methodNotAllowed(response: Response): void {
  response.setHeader('allow', 'POST');
  response.status(405).json({ error: 'Use POST for stateless Streamable HTTP MCP requests.' });
}

function listen(app: Express, port: number): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, MCP_HOST, () => resolve(server));
    server.once('error', reject);
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
