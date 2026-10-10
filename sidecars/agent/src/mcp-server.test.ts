import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchManager } from './batch-manager';
import { EsseApiError } from './api-client';
import { BatchStore } from './batch-store';
import { ImageStore } from './image-store';
import { startDesktopMcpServer, type RunningDesktopMcpServer } from './mcp-server';
import { AUTHORIZED_WORKFLOW_POLICY, WORKFLOW_POLLING, WORKFLOW_TOOL_GUIDANCE } from './workflow-policy';

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

  it('reads the current Provider offering registry for every capability query', async () => {
    const api = fakeApi();
    const [initial] = await api.offerings();
    let current = [initial];
    const fixture = await createFixture({ ...api, offerings: async () => structuredClone(current) });
    const server = await startDesktopMcpServer({
      pairingToken: 'correct-pairing-token',
      port: 0,
      batchManager: fixture.batchManager,
      imageStore: fixture.imageStore,
    });
    runningServers.push(server);
    const client = new Client({ name: 'provider-registry-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint), {
      requestInit: { headers: { authorization: 'Bearer correct-pairing-token' } },
    }));

    const first = firstJson(await client.callTool({ name: 'list_image_offerings', arguments: {} }));
    const firstProviderOfferings = (first.offerings as Array<Record<string, unknown>>).filter((offering) => offering.providerType !== 'agent-generation');
    expect(firstProviderOfferings.map((offering) => offering.providerModelId)).toEqual(['gpt-image-2']);
    current = [{ ...initial, id: 'new-provider:model', providerModelId: 'new-provider-model', canonicalModelId: 'new-provider-model', displayName: 'New Provider Model' }];
    const second = firstJson(await client.callTool({ name: 'list_image_offerings', arguments: {} }));
    const secondProviderOfferings = (second.offerings as Array<Record<string, unknown>>).filter((offering) => offering.providerType !== 'agent-generation');
    expect(secondProviderOfferings.map((offering) => offering.providerModelId)).toEqual(['new-provider-model']);
    await client.close();
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
    const serverInstructions = client.getInstructions();
    expect(serverInstructions).toContain('not an image-generation model or model architecture');
    expect(serverInstructions).toContain('do not ask for another confirmation');
    expect(serverInstructions).toContain('language the user is currently using');
    expect(serverInstructions).toContain('default to Simplified Chinese');
    expect(serverInstructions).toContain(AUTHORIZED_WORKFLOW_POLICY);
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
    expect(tools.tools.find((tool) => tool.name === 'create_image_batch')?.description).toContain('不是某种图像模型或模型架构');
    for (const toolName of ['create_image_batch', 'append_image_batch_jobs', 'modify_selected_images', 'generate_image']) {
      expect(tools.tools.find((tool) => tool.name === toolName)?.description).toContain(WORKFLOW_TOOL_GUIDANCE);
    }
    expect(tools.tools.find((tool) => tool.name === 'list_image_batches')?.description).toContain('requestKey 对账');
    expect(tools.tools.find((tool) => tool.name === 'get_image_batch')?.description).toContain(WORKFLOW_TOOL_GUIDANCE);

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
    expect(desktopSkillText).toContain('A submit-only request may end after handoff');
    expect(desktopSkillText).toContain('not an image-generation model or model architecture');
    expect(desktopSkillText).toContain('generic warning about text, numbers, charts, infographics');
    expect(desktopSkillText).toContain(AUTHORIZED_WORKFLOW_POLICY);
    expect(desktopSkillText).toContain('For a Chinese request, submit Chinese image prompts');
    expect(desktopSkillText).toContain('default to Simplified Chinese');
    expect(desktopSkillText).toContain('enforce the original budget');
    expect(desktopSkillText).toContain('no new user message is required');
    expect(desktopSkillText).toContain('Do not retrieve, display, or act on unrelated tasks');
    expect(desktopSkillText).toContain('pasted or attached');
    expect(desktopSkillText).toContain('referenceImagePaths');
    expect(desktopSkillText).toContain('do not submit a misleading text-only edit');
    expect(desktopSkillText).not.toContain('State the actual Provider, request count, and exact estimated total');

    const quote = await client.callTool({ name: 'list_image_offerings', arguments: {} });
    const quotePayload = firstJson(quote);
    expect(quotePayload).toMatchObject({
      offerings: expect.arrayContaining([
        expect.objectContaining({ providerName: 'Tuzi default', estimatedPricePerImage: '0.10' }),
        expect.objectContaining({ id: 'workbuddy-agent-generation', providerType: 'agent-generation' }),
      ]),
      conversationPolicy: expect.stringContaining('Only discuss'),
    });
    expect((quotePayload as { offerings: Array<Record<string, unknown>> }).offerings.find((offering) => offering.id === 'workbuddy-agent-generation')).not.toHaveProperty('estimatedPricePerImage');
    expect(quotePayload).not.toHaveProperty('approvalRequired');

    const result = await client.callTool({
      name: 'create_image_batch',
      arguments: {
        title: 'Green cat batch',
        jobs: [{ prompt: 'A small green cat' }],
        requestKey: 'workbuddy-test-request-1',
      },
    });
    const accepted = firstJson(result) as { accepted: boolean; execution: string; message: string; nextAction: string; batch: { id: string; jobs: Array<{ id: string }> } };
    expect(accepted).toMatchObject({
      accepted: true,
      execution: 'background',
      message: '已交给 Esse 后台生成。',
      nextAction: AUTHORIZED_WORKFLOW_POLICY,
      polling: WORKFLOW_POLLING,
      batch: { id: expect.any(String), jobs: [expect.objectContaining({ id: expect.any(String) })] },
    });
    expect(accepted.batch.id).toBeTruthy();
    expect(JSON.stringify(accepted)).not.toMatch(/Tuzi|\.png|\\outputs\\/i);
    const acceptedBatch = fixture.batchManager.list().find((batch) => batch.title === 'Green cat batch');
    expect(acceptedBatch).toBeTruthy();
    const acceptedBatchId = accepted.batch.id;
    expect(acceptedBatchId).toBe(acceptedBatch!.id);
    await vi.waitFor(() => expect(generated).toHaveBeenCalledTimes(1));
    expect(fixture.batchManager.get(acceptedBatchId).status).toBe('running');
    const pending = firstJson(await client.callTool({ name: 'get_image_batch', arguments: { batchId: acceptedBatchId } }));
    expect(pending).toMatchObject({ batch: { id: acceptedBatchId, status: 'running' }, polling: WORKFLOW_POLLING });
    expect(generated).toHaveBeenCalledTimes(1);

    const generatedBytes = testPng('generated-original');
    completeGeneration({
      requestId: 'request-1',
      items: [{ b64_json: generatedBytes.toString('base64') }],
      reused: false,
    });
    await vi.waitFor(() => expect(fixture.batchManager.get(acceptedBatchId).status).toBe('completed'));
    const completed = fixture.batchManager.get(acceptedBatchId);
    const imageId = completed.jobs[0].outputImageId;
    expect(imageId).toBeTruthy();
    expect(await readFile(await fixture.imageStore.pathForId(imageId!))).toEqual(generatedBytes);

    const backgroundPath = path.join(fixture.directory, 'Clipboard_Screenshot.png');
    await writeFile(backgroundPath, testPng('home-background'));
    const modification = firstJson(await client.callTool({
      name: 'modify_selected_images',
      arguments: {
        batchId: acceptedBatchId,
        imageIds: [imageId],
        referenceImagePaths: [backgroundPath],
        instructions: 'place the subject in the attached home interior',
        requestKey: 'workbuddy-modify-with-attachment-1',
      },
    })) as { accepted: boolean; execution: string; message: string };
    expect(modification).toMatchObject({ accepted: true, execution: 'background', message: '已交给 Esse 后台生成。', nextAction: AUTHORIZED_WORKFLOW_POLICY });
    expect(modification).toHaveProperty('batch.id', acceptedBatchId);
    expect(modification).toHaveProperty('modifiedJobIds', [completed.jobs[0].id]);
    await vi.waitFor(() => expect(fixture.batchManager.get(acceptedBatchId).status).toBe('completed'));
    const modifiedJob = fixture.batchManager.get(acceptedBatchId).jobs[0];
    expect(modifiedJob.referenceImageIds).toHaveLength(2);
    expect(modifiedJob.referenceImageIds[0]).toBe(imageId);
    const importedBackground = await fixture.imageStore.get(modifiedJob.referenceImageIds[1]);
    expect(importedBackground).toMatchObject({ sourceFileName: 'Clipboard_Screenshot.png', prompt: 'Esse reference image' });

    const appended = firstJson(await client.callTool({
      name: 'append_image_batch_jobs',
      arguments: {
        batchId: acceptedBatchId,
        prompt: 'A second small green cat',
        requestKey: 'workbuddy-append-background-1',
      },
    }));
    expect(appended).toMatchObject({ accepted: true, execution: 'background', nextAction: AUTHORIZED_WORKFLOW_POLICY });
    expect(appended).toHaveProperty('batch.id', acceptedBatchId);
    expect(appended).toHaveProperty('appendedJobIds');
    await vi.waitFor(() => expect(fixture.batchManager.get(acceptedBatchId).status).toBe('completed'));

    const generatedPath = await fixture.imageStore.pathForId(imageId!);
    const pathBatchResult = await client.callTool({
      name: 'create_image_batch',
      arguments: {
        title: 'Exact local path batch',
        prompt: 'fallback prompt',
        imagePaths: [generatedPath],
        perImagePrompts: { [path.basename(generatedPath)]: 'edit the exact local input' },
        requestKey: 'workbuddy-path-batch-1',
      },
    });
    expect(firstJson(pathBatchResult)).toHaveProperty('batch.id');
    const pathBatch = fixture.batchManager.list().find((batch) => batch.title === 'Exact local path batch');
    expect(pathBatch).toBeTruthy();
    await vi.waitFor(() => expect(fixture.batchManager.get(pathBatch!.id).status).toBe('completed'));
    expect(fixture.batchManager.get(pathBatch!.id).jobs[0]).toMatchObject({
      prompt: 'edit the exact local input',
      referenceImageIds: [expect.any(String)],
    });

    const listed = firstJson(await client.callTool({ name: 'list_image_batches', arguments: { limit: 10 } })) as {
      batches: Array<{ id: string; jobs?: unknown[]; images?: unknown[] }>;
    };
    expect(listed.batches.find((batch) => batch.id === pathBatch!.id)).toMatchObject({
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

  it('returns a save error without publishing a receipt or executing the rejected edit later', async () => {
    const edit = vi.fn(fakeApi().edit);
    const fixture = await createFixture({ ...fakeApi(), edit });
    const server = await startDesktopMcpServer({ pairingToken: 'save-failure-token', port: 0, batchManager: fixture.batchManager, imageStore: fixture.imageStore });
    runningServers.push(server);
    const client = new Client({ name: 'save-failure-review', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint), { requestInit: { headers: { authorization: 'Bearer save-failure-token' } } }));
    const mother = firstJson(await client.callTool({ name: 'create_image_batch', arguments: { prompt: 'mother', requestKey: 'parent-save-mother' } })).batch as { id: string };
    await fixture.batchManager.waitForIdle();
    const before = fixture.batchManager.get(mother.id);
    const save = vi.spyOn(BatchStore.prototype, 'save').mockRejectedValueOnce(new Error('injected disk-save failure'));
    const failed = await client.callTool({ name: 'modify_selected_images', arguments: { batchId: mother.id, imageIds: [before.jobs[0].outputImageId], instructions: 'rework', requestKey: 'parent-failed-save' } });
    save.mockRestore();
    const memoryAfterFailure = fixture.batchManager.get(mother.id);
    const receipt = firstJson(await client.callTool({ name: 'list_image_batches', arguments: { requestKey: 'parent-failed-save', limit: 1 } }));
    const disk = (await new BatchStore(path.join(fixture.directory, 'batches')).loadAll()).find(batch => batch.id === mother.id)!;
    await client.callTool({ name: 'create_image_batch', arguments: { prompt: 'unrelated', requestKey: 'parent-unrelated-batch' } });
    await fixture.batchManager.waitForIdle();
    expect({ isError: failed.isError, memoryStatus: memoryAfterFailure.jobs[0].status, diskStatus: disk.jobs[0].status,
      receiptCount: (receipt.batches as unknown[]).length, editCalls: edit.mock.calls.length,
    }).toEqual({ isError: true, memoryStatus: 'succeeded', diskStatus: 'succeeded', receiptCount: 0, editCalls: 0 });
    expect(memoryAfterFailure).toEqual(before);
    expect(disk.jobs).toEqual(before.jobs);
    await client.close();
  });

  it('reports a shared append receipt as ambiguous before either list limit can hide a match', async () => {
    const generate = vi.fn(fakeApi().generate);
    const fixture = await createFixture({ ...fakeApi(), generate });
    const server = await startDesktopMcpServer({ pairingToken: 'ambiguity-token', port: 0, batchManager: fixture.batchManager, imageStore: fixture.imageStore });
    runningServers.push(server);
    const client = new Client({ name: 'ambiguity-review', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint), { requestInit: { headers: { authorization: 'Bearer ambiguity-token' } } }));
    const ids: string[] = [];
    for (const title of ['A', 'B']) {
      const result = firstJson(await client.callTool({ name: 'create_image_batch', arguments: { prompt: title, requestKey: `parent-create-${title}` } }));
      const batchId = (result.batch as { id: string }).id;
      ids.push(batchId);
      await client.callTool({ name: 'append_image_batch_jobs', arguments: { batchId, prompt: 'append', requestKey: 'shared-append-key' } });
    }
    await fixture.batchManager.waitForIdle();
    const calls = generate.mock.calls.length;
    for (const limit of [1, 50]) {
      const result = await client.callTool({ name: 'list_image_batches', arguments: { requestKey: 'shared-append-key', limit } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('Ambiguous requestKey: 2 batches match');
      expect(result.structuredContent).toMatchObject({ error: expect.stringContaining('Ambiguous requestKey: 2 batches match') });
      expect(result.structuredContent).not.toHaveProperty('batches');
    }
    for (const batchId of ids) expect(firstJson(await client.callTool({ name: 'get_image_batch', arguments: { batchId } }))).toHaveProperty('batch.id', batchId);
    const restarted = new BatchManager({ store: new BatchStore(path.join(fixture.directory, 'batches')), imageStore: fixture.imageStore, createApiClient: async () => ({ ...fakeApi(), generate }) });
    await restarted.initialize();
    expect(() => restarted.list('shared-append-key')).toThrow('Ambiguous requestKey: 2 batches match');
    expect(generate).toHaveBeenCalledTimes(calls);
    await client.close();
  });

  it('continues an authorized product workflow with real offline pixels, one task-scoped rework and failed-item archival', async () => {
    const generate = vi.fn(async (...args: unknown[]) => {
      const prompt = (args[0] as { prompt: string }).prompt;
      if (prompt === 'D mother') throw new EsseApiError('Submission outcome unknown', { code: 'unknown_fixture', chargeState: 'unknown', origin: 'transport' });
      return pixelResult(prompt, prompt === 'B mother' || prompt === 'C mother' ? 'reject' : 'accept');
    });
    const edit = vi.fn(async (...args: unknown[]) => {
      const prompt = (args[0] as { prompt: string }).prompt;
      return pixelResult(prompt, prompt === 'C rework' ? 'reject' : 'accept');
    });
    const fixture = await createFixture({ ...fakeApi(), generate, edit });
    const server = await startDesktopMcpServer({ pairingToken: 'offline-workflow-token', port: 0, batchManager: fixture.batchManager, imageStore: fixture.imageStore });
    runningServers.push(server);
    const client = new Client({ name: 'authorized-workflow-fixture', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint), { requestInit: { headers: { authorization: 'Bearer offline-workflow-token' } } }));
    const authorization = { products: ['A', 'B', 'C', 'D'], maxReworksPerProduct: 1, angles: 2, maxRequests: 10 };
    const archived = path.join(fixture.directory, 'accepted-archive');
    await mkdir(archived);
    const summary: Array<{ product: string; batchId: string; accepted: boolean; reworks: number; reason?: string }> = [];
    for (const product of authorization.products) {
      const requestKey = `workflow-${product}-mother`;
      const result = firstJson(await client.callTool({ name: 'create_image_batch', arguments: { title: product, prompt: `${product} mother`, requestKey } }));
      expect(result).toMatchObject({ accepted: true, execution: 'background', nextAction: AUTHORIZED_WORKFLOW_POLICY, polling: WORKFLOW_POLLING });
      const batchId = (result.batch as { id: string }).id;
      // Simulate losing the handoff in a previous turn: recover by its exact key,
      // never by newest batch or another creation request.
      const reconciled = firstJson(await client.callTool({ name: 'list_image_batches', arguments: { requestKey, limit: 1 } }));
      expect((reconciled.batches as Array<{ id: string }>).map(batch => batch.id)).toEqual([batchId]);
      await fixture.batchManager.waitForIdle();
      let batch = (firstJson(await client.callTool({ name: 'get_image_batch', arguments: { batchId } })).batch as Awaited<ReturnType<BatchManager['create']>> & { images: Array<{ id: string; name: string; path: string }> });
      let reworks = 0;
      if (batch.status === 'failed') {
        expect(batch.jobs[0].chargeState).toBe('unknown');
        summary.push({ product, batchId, accepted: false, reworks, reason: 'unknown submission; no resubmission' });
        continue;
      }
      let mother = batch.images.find(image => image.name === '图1')!;
      while (!await acceptsPixels(mother.path) && reworks < authorization.maxReworksPerProduct) {
        reworks += 1;
        const modified = firstJson(await client.callTool({ name: 'modify_selected_images', arguments: { batchId, imageIds: [mother.id], instructions: `${product} rework`, requestKey: `workflow-${product}-rework-${reworks}` } }));
        expect(modified).toHaveProperty('batch.id', batchId);
        expect(modified).toHaveProperty('modifiedJobIds', [batch.jobs[0].id]);
        await fixture.batchManager.waitForIdle();
        batch = firstJson(await client.callTool({ name: 'get_image_batch', arguments: { batchId } })).batch as typeof batch;
        const backup = batch.images.find(image => image.name === '图1-1')!;
        expect(await acceptsPixels(backup.path)).toBe(false);
        mother = batch.images.find(image => image.name === '图1')!;
      }
      if (!await acceptsPixels(mother.path)) {
        summary.push({ product, batchId, accepted: false, reworks, reason: 'pixel rejection after authorized rework limit' });
        continue;
      }
      const appended = firstJson(await client.callTool({ name: 'append_image_batch_jobs', arguments: {
        batchId, requestKey: `workflow-${product}-angles`,
        jobs: Array.from({ length: authorization.angles }, (_, index) => ({ prompt: `${product} angle ${index + 1}`, referenceImages: [{ batchId, image: '图1' }] })),
      } }));
      expect(appended).toHaveProperty('batch.id', batchId);
      expect(appended.appendedJobIds).toHaveLength(authorization.angles);
      await fixture.batchManager.waitForIdle();
      batch = firstJson(await client.callTool({ name: 'get_image_batch', arguments: { batchId } })).batch as typeof batch;
      expect(batch.jobs).toHaveLength(1 + authorization.angles);
      for (const job of batch.jobs.slice(1)) expect(job.referenceImageIds).toEqual([mother.id]);
      for (const image of batch.images.filter(image => !image.name.includes('-'))) {
        expect(await acceptsPixels(image.path)).toBe(true);
        await copyFile(image.path, path.join(archived, `${product}-${image.name}.png`));
      }
      summary.push({ product, batchId, accepted: true, reworks });
    }
    await writeFile(path.join(archived, 'acceptance.json'), JSON.stringify(summary));
    expect(new Set(summary.map(item => item.batchId)).size).toBe(authorization.products.length);
    expect(summary.map(({ product, accepted, reworks }) => ({ product, accepted, reworks }))).toEqual([
      { product: 'A', accepted: true, reworks: 0 }, { product: 'B', accepted: true, reworks: 1 },
      { product: 'C', accepted: false, reworks: 1 }, { product: 'D', accepted: false, reworks: 0 },
    ]);
    expect(generate).toHaveBeenCalledTimes(4);
    // Angles have their accepted mother as a reference, so they use edit,
    // alongside the two bounded mother reworks.
    expect(edit).toHaveBeenCalledTimes(6);
    expect(generate.mock.calls.length + edit.mock.calls.length).toBe(authorization.maxRequests);
    const persisted = JSON.parse(await readFile(path.join(archived, 'acceptance.json'), 'utf8')) as typeof summary;
    expect(persisted.filter(item => !item.accepted).map(item => item.product)).toEqual(['C', 'D']);
    const oldest = firstJson(await client.callTool({ name: 'list_image_batches', arguments: { requestKey: 'workflow-A-mother', limit: 1 } }));
    expect((oldest.batches as Array<{ id: string }>).map(batch => batch.id)).toEqual([summary[0].batchId]);
    const restarted = new BatchManager({ store: new BatchStore(path.join(fixture.directory, 'batches')), imageStore: fixture.imageStore, createApiClient: async () => ({ ...fakeApi(), generate, edit }) });
    await restarted.initialize();
    await restarted.waitForIdle();
    expect(restarted.list('workflow-A-mother')[0].id).toBe(summary[0].batchId);
    expect(restarted.list('workflow-B-rework-1')[0].id).toBe(summary[1].batchId);
    expect(restarted.list('workflow-B-angles')[0].id).toBe(summary[1].batchId);
    expect(restarted.get(summary[3].batchId).jobs[0].chargeState).toBe('unknown');
    expect(generate.mock.calls.length + edit.mock.calls.length).toBe(authorization.maxRequests);
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
    const [secondSource] = await fixture.imageStore.saveBatch({
      requestId: 'agent-source-two',
      prompt: 'agent source two',
      model: 'local-reference',
      items: [{ b64_json: testPng('agent-source-two').toString('base64') }],
    });
    const firstSourcePath = await fixture.imageStore.pathForId(source.id);
    const secondSourcePath = await fixture.imageStore.pathForId(secondSource.id);
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
        jobs: [
          { prompt: 'draw the first reference', referenceImageIds: [source.id] },
          { prompt: 'draw the second reference', referenceImageIds: [secondSource.id] },
        ],
        requestKey: 'workbuddy-agent-batch-1',
      },
    })) as { execution: string; batch: { id: string; jobs: Array<{ id: string }> } };
    expect(accepted.execution).toBe('current-agent');
    expect(generate).not.toHaveBeenCalled();
    expect(JSON.stringify(accepted)).not.toContain(firstSourcePath);
    expect(JSON.stringify(accepted)).not.toContain(secondSourcePath);

    const [firstJob, secondJob] = accepted.batch.jobs;
    const started = firstJson(await client.callTool({
      name: 'start_agent_image_job',
      arguments: { batchId: accepted.batch.id, jobId: firstJob.id },
    })) as { batch: unknown; job: { prompt: string; referenceImagePaths: string[] } };
    expect(started.job).toMatchObject({ prompt: 'draw the first reference', referenceImagePaths: [firstSourcePath] });
    expect(JSON.stringify(started.batch)).not.toContain(secondSourcePath);
    const completed = firstJson(await client.callTool({
      name: 'complete_agent_image_job',
      arguments: { batchId: accepted.batch.id, jobId: firstJob.id, imagePath: firstSourcePath },
    })) as { job: { status: string } };
    expect(completed.job.status).toBe('succeeded');
    const secondStarted = firstJson(await client.callTool({
      name: 'start_agent_image_job',
      arguments: { batchId: accepted.batch.id, jobId: secondJob.id },
    })) as { batch: unknown; job: { referenceImagePaths: string[] } };
    expect(secondStarted.job.referenceImagePaths).toEqual([secondSourcePath]);
    expect(JSON.stringify(secondStarted.batch)).not.toContain(firstSourcePath);
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
    resume: async () => ({
      requestId: 'resume-1',
      items: [{ b64_json: testPng('resumed-original').toString('base64') }],
      reused: false,
    }),
  };
}

function testPng(content: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(content)]);
}

function pixelResult(requestId: string, verdict: 'accept' | 'reject') {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(3, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(3 * 9);
  for (let row = 0; row < 3; row++) for (let column = 0; column < 2; column++) {
    const offset = row * 9 + 1 + column * 4;
    rows[offset + (verdict === 'accept' ? 1 : 0)] = 255;
    rows[offset + 3] = 255;
  }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
  return { requestId, items: [{ b64_json: png.toString('base64') }], reused: false };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  payload.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

async function acceptsPixels(filePath: string) {
  const bytes = await readFile(filePath);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([2, 3]);
  const length = bytes.readUInt32BE(33);
  const pixels = inflateSync(bytes.subarray(41, 41 + length));
  return pixels[1] === 0 && pixels[2] === 255;
}
