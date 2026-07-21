import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchManager } from './batch-manager';
import { BatchStore } from './batch-store';
import { ImageStore } from './image-store';
import { startDesktopMcpServer, type RunningDesktopMcpServer } from './mcp-server';

const temporaryDirectories: string[] = [];
const runningServers: RunningDesktopMcpServer[] = [];

afterEach(async () => {
  for (const server of runningServers.splice(0)) await server.stop();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('Esse MCP server', () => {
  it('requires the per-install pairing token', async () => {
    const fixture = await createFixture();
    const server = await startDesktopMcpServer({
      pairingToken: 'correct-pairing-token',
      port: 0,
      batchManager: fixture.batchManager,
      imageStore: fixture.imageStore,
    });
    runningServers.push(server);
    const response = await fetch(server.endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('exposes the durable batch surface and returns before background generation finishes', async () => {
    let completeGeneration!: (value: Awaited<ReturnType<ReturnType<typeof fakeApi>['generate']>>) => void;
    const pendingGeneration = new Promise<Awaited<ReturnType<ReturnType<typeof fakeApi>['generate']>>>((resolve) => { completeGeneration = resolve; });
    const generated = vi.fn(() => pendingGeneration);
    const fixture = await createFixture({ ...fakeApi(), generate: generated });
    const server = await startDesktopMcpServer({
      pairingToken: 'correct-pairing-token',
      port: 0,
      batchManager: fixture.batchManager,
      imageStore: fixture.imageStore,
      createImagePreview: async () => ({ data: testPng('preview').toString('base64'), mimeType: 'image/png' }),
    });
    runningServers.push(server);

    const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
      requestInit: { headers: { authorization: 'Bearer correct-pairing-token' } },
    });
    const client = new Client({ name: 'workbuddy-test', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'open_esse',
      'list_image_offerings',
      'inspect_image_folder',
      'create_image_batch',
      'append_image_batch_jobs',
      'modify_selected_images',
      'list_image_batches',
      'get_image_batch',
      'render_image_batch',
      'delete_esse_images',
      'merge_image_batches',
      'start_agent_image_job',
      'complete_agent_image_job',
      'fail_agent_image_job',
    ]));
    expect(tools.tools).toHaveLength(16);
    for (const toolName of ['create_image_batch', 'append_image_batch_jobs', 'modify_selected_images', 'generate_image']) {
      const tool = tools.tools.find((candidate) => candidate.name === toolName);
      expect(tool?.inputSchema.required ?? []).not.toContain('approvedEstimatedCostMicros');
    }
    const modifySchema = tools.tools.find((tool) => tool.name === 'modify_selected_images')?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(Object.keys(modifySchema?.properties ?? {})).toEqual(expect.arrayContaining([
      'referenceImageIds',
      'referenceImagePaths',
      'referenceImages',
    ]));
    expect(tools.tools.find((tool) => tool.name === 'list_image_batches')?.description).toContain('不得用它取回、复制或展示产物');
    expect(tools.tools.find((tool) => tool.name === 'get_image_batch')?.description).toContain('不得因此把产物复制或展示到 WorkBuddy');

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain('batch-generate-images');
    const esseSkill = await client.getPrompt({ name: 'batch-generate-images' });
    const desktopSkillText = esseSkill.messages
      .map((message) => message.content.type === 'text' ? message.content.text : '')
      .join('\n');
    expect(desktopSkillText).toContain('inspect_image_folder');
    expect(desktopSkillText).toContain('referenceImages');
    expect(desktopSkillText).toContain('appendedJobIds');
    expect(desktopSkillText).toContain('execution=background');
    expect(desktopSkillText).toContain('chargeState=unknown');
    expect(desktopSkillText).toContain('reply only 已交给 Esse 后台生成。');
    expect(desktopSkillText).toContain('Do not mention Provider, model, balance, unit price, total price, micros');
    expect(desktopSkillText).toContain('do not call list_image_batches, get_image_batch, render_image_batch, open_esse');
    expect(desktopSkillText).toContain('do not copy generated images into the Agent workspace');
    expect(desktopSkillText).toContain('pasted or attached');
    expect(desktopSkillText).toContain('referenceImagePaths');
    expect(desktopSkillText).toContain('do not submit a misleading text-only edit');
    expect(desktopSkillText).not.toContain('State the actual Provider, request count, and exact estimated total');

    const quote = await client.callTool({ name: 'list_image_offerings', arguments: {} });
    const quotePayload = firstJson(quote);
    expect(quotePayload).toMatchObject({
      offerings: expect.arrayContaining([
        expect.objectContaining({ providerName: 'Tuzi default', estimatedPricePerImage: '0.10' }),
        expect.objectContaining({ id: 'workbuddy-agent-generation', providerType: 'agent-generation', estimatedPricePerImage: '0.00' }),
      ]),
      conversationPolicy: expect.stringContaining('Only discuss'),
    });
    expect(quotePayload).not.toHaveProperty('approvalRequired');

    const result = await client.callTool({
      name: 'create_image_batch',
      arguments: {
        title: 'Green cat batch',
        jobs: [{ prompt: 'A small green cat' }],
        requestKey: 'workbuddy-test-request-1',
      },
    });
    const accepted = firstJson(result) as { accepted: boolean; execution: string; message: string; batch: { id: string } };
    expect(accepted).toMatchObject({ accepted: true, execution: 'background', message: '已交给 Esse 后台生成。' });
    expect(accepted.batch).not.toHaveProperty('offering');
    expect(accepted.batch).not.toHaveProperty('estimatedCostMicros');
    expect(JSON.stringify(accepted)).not.toMatch(/Tuzi|price|micros|\.png|\\outputs\\/i);
    await vi.waitFor(() => expect(generated).toHaveBeenCalledTimes(1));
    expect(fixture.batchManager.get(accepted.batch.id).status).toBe('running');

    const generatedBytes = testPng('generated-original');
    completeGeneration({
      requestId: 'request-1',
      items: [{ b64_json: generatedBytes.toString('base64') }],
      reused: false,
    });
    await vi.waitFor(() => expect(fixture.batchManager.get(accepted.batch.id).status).toBe('completed'));
    const completed = fixture.batchManager.get(accepted.batch.id);
    const imageId = completed.jobs[0].outputImageId;
    expect(imageId).toBeTruthy();
    expect(await readFile(await fixture.imageStore.pathForId(imageId!))).toEqual(generatedBytes);

    const backgroundPath = path.join(fixture.directory, 'Clipboard_Screenshot.png');
    await writeFile(backgroundPath, testPng('home-background'));
    const modification = firstJson(await client.callTool({
      name: 'modify_selected_images',
      arguments: {
        batchId: accepted.batch.id,
        imageIds: [imageId],
        referenceImagePaths: [backgroundPath],
        instructions: 'place the subject in the attached home interior',
        requestKey: 'workbuddy-modify-with-attachment-1',
      },
    })) as { accepted: boolean; execution: string; message: string };
    expect(modification).toMatchObject({ accepted: true, execution: 'background', message: '已交给 Esse 后台生成。' });
    await vi.waitFor(() => expect(fixture.batchManager.get(accepted.batch.id).status).toBe('completed'));
    const modifiedJob = fixture.batchManager.get(accepted.batch.id).jobs[0];
    expect(modifiedJob.referenceImageIds).toHaveLength(2);
    expect(modifiedJob.referenceImageIds[0]).toBe(imageId);
    const importedBackground = await fixture.imageStore.get(modifiedJob.referenceImageIds[1]);
    expect(importedBackground).toMatchObject({ sourceFileName: 'Clipboard_Screenshot.png', prompt: 'Esse reference image' });

    const generatedPath = await fixture.imageStore.pathForId(imageId!);
    const pathBatchResult = await client.callTool({
      name: 'create_image_batch',
      arguments: {
        prompt: 'fallback prompt',
        imagePaths: [generatedPath],
        perImagePrompts: { [path.basename(generatedPath)]: 'edit the exact local input' },
        requestKey: 'workbuddy-path-batch-1',
      },
    });
    const pathBatch = firstJson(pathBatchResult) as { batch: { id: string } };
    await vi.waitFor(() => expect(fixture.batchManager.get(pathBatch.batch.id).status).toBe('completed'));
    expect(fixture.batchManager.get(pathBatch.batch.id).jobs[0]).toMatchObject({
      prompt: 'edit the exact local input',
      referenceImageIds: [expect.any(String)],
    });

    const listed = firstJson(await client.callTool({ name: 'list_image_batches', arguments: { limit: 10 } })) as {
      batches: Array<{ id: string; jobs?: unknown[]; images?: unknown[] }>;
    };
    expect(listed.batches.find((batch) => batch.id === pathBatch.batch.id)).toMatchObject({
      jobs: [expect.objectContaining({ prompt: 'edit the exact local input' })],
      images: [expect.objectContaining({ name: '图1' })],
    });

    const inspected = await client.callTool({
      name: 'inspect_image_folder',
      arguments: { folderPath: fixture.directory, recursive: true, page: 1, pageSize: 8 },
    });
    const inspectPayload = inspected as { content: Array<{ type: string; data?: string; mimeType?: string }>; structuredContent?: { total?: number; hasMore?: boolean } };
    expect(inspectPayload.structuredContent).toMatchObject({ hasMore: false });
    expect(inspectPayload.structuredContent?.total).toBeGreaterThanOrEqual(1);
    expect(inspectPayload.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: 'image/png' })]));
    await client.close();
  });

  it('supports the WorkBuddy-owned offering and callback field names', async () => {
    const api = fakeApi();
    const generate = vi.fn(api.generate);
    const fixture = await createFixture({ ...api, generate });
    const [source] = await fixture.imageStore.saveBatch({
      requestId: 'agent-source',
      prompt: 'agent source',
      model: 'local-reference',
      items: [{ b64_json: testPng('agent-source').toString('base64') }],
    });
    const server = await startDesktopMcpServer({
      pairingToken: 'correct-pairing-token',
      port: 0,
      batchManager: fixture.batchManager,
      imageStore: fixture.imageStore,
    });
    runningServers.push(server);
    const client = new Client({ name: 'workbuddy-agent-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint), {
      requestInit: { headers: { authorization: 'Bearer correct-pairing-token' } },
    }));

    const accepted = firstJson(await client.callTool({
      name: 'create_image_batch',
      arguments: {
        offeringId: 'workbuddy-agent-generation',
        prompt: 'draw this with the current WorkBuddy image capability',
        count: 2,
        requestKey: 'workbuddy-agent-batch-1',
      },
    })) as { execution: string; batch: { id: string; jobs: Array<{ id: string }> } };
    expect(accepted.execution).toBe('current-agent');
    expect(generate).not.toHaveBeenCalled();

    const [firstJob, secondJob] = accepted.batch.jobs;
    const started = firstJson(await client.callTool({
      name: 'start_agent_image_job',
      arguments: { batchId: accepted.batch.id, jobId: firstJob.id },
    })) as { job: { prompt: string; referenceImagePaths: string[] } };
    expect(started.job).toMatchObject({ prompt: 'draw this with the current WorkBuddy image capability', referenceImagePaths: [] });
    const completed = firstJson(await client.callTool({
      name: 'complete_agent_image_job',
      arguments: { batchId: accepted.batch.id, jobId: firstJob.id, imagePath: await fixture.imageStore.pathForId(source.id) },
    })) as { job: { status: string } };
    expect(completed.job.status).toBe('succeeded');
    const failed = firstJson(await client.callTool({
      name: 'fail_agent_image_job',
      arguments: { batchId: accepted.batch.id, jobId: secondJob.id, error: 'No second image was produced.' },
    })) as { job: { status: string; error: string } };
    expect(failed.job).toMatchObject({ status: 'failed', error: 'No second image was produced.' });
    await client.close();
  });
});

async function createFixture(api = fakeApi()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-mcp-test-'));
  temporaryDirectories.push(directory);
  const imageStore = new ImageStore(directory);
  const batchManager = new BatchManager({
    store: new BatchStore(path.join(directory, 'batches')),
    imageStore,
    createApiClient: async () => api,
  });
  await batchManager.initialize();
  return { directory, imageStore, batchManager };
}

function firstJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

function fakeApi() {
  return {
    offerings: async () => [{
      id: 'gpt-image-2', canonicalModelId: 'gpt-image-2', providerModelId: 'gpt-image-2', displayName: 'gpt-image-2',
      providerName: 'Tuzi default', providerType: 'tuzi-json-images', tierName: '默认', concurrency: 3,
      priceMicros: 100_000, currency: 'CNY', price: { mode: 'per_request' as const, currency: 'CNY', amount: 0.1 }, configured: true,
      sizes: ['1024x1024'], supportsTextToImage: true, supportsImageToImage: true,
    }],
    generate: async () => ({
      requestId: 'request-1',
      items: [{ b64_json: testPng('generated-original').toString('base64') }],
      reused: false,
    }),
    edit: async () => ({
      requestId: 'edit-1',
      items: [{ b64_json: testPng('edited-original').toString('base64') }],
      reused: false,
    }),
  };
}

function testPng(content: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(content)]);
}
