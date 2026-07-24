import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EsseApiError } from './api-client';
import { BatchManager } from './batch-manager';
import { BatchStore } from './batch-store';
import { ImageStore } from './image-store';

const temporaryDirectories: string[] = [];
const managers: BatchManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.waitForIdle()));
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('Esse batch manager', () => {
  it('uses the configured Provider price silently when the legacy estimate is omitted', async () => {
    const fixture = await fixtureDirectory();
    const manager = managerFor(fixture, fakeApi(), { canRun: async () => false });
    await manager.initialize();

    const accepted = await manager.create({
      prompt: 'silent current-price generation',
      requestKey: 'silent-current-price-request',
    });
    expect(accepted).toMatchObject({ status: 'queued', estimatedCostMicros: 100_000 });

    await expect(manager.create({
      prompt: 'stale legacy estimate',
      requestKey: 'stale-legacy-price-request',
      approvedEstimatedCostMicros: 50_000,
    })).rejects.toThrow(/retry without approvedEstimatedCostMicros/i);
  });

  it('persists independent jobs before starting them and respects configured concurrency', async () => {
    const fixture = await fixtureDirectory();
    const pending = new Map<string, (value: ReturnType<typeof generatedResult>) => void>();
    const generate = vi.fn((input?: unknown) => {
      const prompt = (input as { prompt: string }).prompt;
      return new Promise<ReturnType<typeof generatedResult>>((resolve) => pending.set(prompt, resolve));
    });
    const manager = managerFor(fixture, { ...fakeApi(), generate }, { concurrency: 2 });
    await manager.initialize();

    const accepted = await manager.create({
      title: 'Three independent insects',
      jobs: [{ prompt: 'gold beetle' }, { prompt: 'blue beetle' }, { prompt: 'red beetle' }],
      requestKey: 'parallel-beetles-request',
      approvedEstimatedCostMicros: 300_000,
    });
    expect(accepted.jobs.map((job) => job.prompt)).toEqual(['gold beetle', 'blue beetle', 'red beetle']);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(manager.get(accepted.id)).toMatchObject({ running: 2, queued: 1 });

    pending.get('gold beetle')!(generatedResult('gold'));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
    expect(generate.mock.calls.map(([input]) => (input as { prompt: string }).prompt)).toEqual(['gold beetle', 'blue beetle', 'red beetle']);
    pending.get('blue beetle')!(generatedResult('blue'));
    pending.get('red beetle')!(generatedResult('red'));
    await vi.waitFor(() => expect(manager.get(accepted.id).status).toBe('completed'));
  });

  it('waits for background generation and persistence before reporting idle', async () => {
    const fixture = await fixtureDirectory();
    let finishGeneration!: (value: ReturnType<typeof generatedResult>) => void;
    const generate = vi.fn(() => new Promise<ReturnType<typeof generatedResult>>((resolve) => {
      finishGeneration = resolve;
    }));
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    await manager.initialize();
    const accepted = await manager.create({
      prompt: 'finish persistence before cleanup',
      requestKey: 'wait-for-background-persistence',
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

    let idle = false;
    const waiting = manager.waitForIdle().then(() => { idle = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle).toBe(false);

    finishGeneration(generatedResult('persisted-before-idle'));
    await waiting;
    expect(manager.get(accepted.id).status).toBe('completed');
  });

  it('resumes durable queued work after Esse restarts', async () => {
    const fixture = await fixtureDirectory();
    const first = managerFor(fixture, fakeApi(), { canRun: async () => false });
    await first.initialize();
    const accepted = await first.create({
      prompt: 'resume me',
      requestKey: 'durable-resume-request',
      approvedEstimatedCostMicros: 100_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.get(accepted.id).status).toBe('queued');

    const generate = vi.fn(fakeApi().generate);
    const restarted = managerFor(fixture, { ...fakeApi(), generate });
    await restarted.initialize();
    await vi.waitFor(() => expect(restarted.get(accepted.id).status).toBe('completed'));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown-charge failure terminal unless the user explicitly confirms a manual retry', async () => {
    const fixture = await fixtureDirectory();
    const generate = vi.fn(async () => {
      throw new EsseApiError('Provider result is unknown.', { code: 'provider_result_unknown', requestId: 'request-review', status: 503, chargeState: 'unknown', origin: 'upstream' });
    });
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    await manager.initialize();
    const accepted = await manager.create({
      prompt: 'ambiguous charge',
      requestKey: 'unknown-charge-request',
      approvedEstimatedCostMicros: 100_000,
    });
    await vi.waitFor(() => expect(manager.get(accepted.id).status).toBe('failed'));
    const job = manager.get(accepted.id).jobs[0];
    expect(job).toMatchObject({ chargeState: 'unknown', retryable: true, requestId: 'request-review', errorOrigin: 'upstream' });
    expect(job.callHistory[0]).toMatchObject({ errorOrigin: 'upstream' });
    expect(generate).toHaveBeenCalledTimes(1);
    await expect(manager.retry(accepted.id, [job.id])).rejects.toThrow(/explicit unknown-charge confirmation/i);
    expect(generate).toHaveBeenCalledTimes(1);
    await manager.retry(accepted.id, [job.id], true);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(manager.get(accepted.id).status).toBe('failed'));
    expect(manager.get(accepted.id).jobs[0].callHistory).toHaveLength(2);
  });

  it('allows manual retry for a Provider failure that is not eligible for automatic retry', async () => {
    const fixture = await fixtureDirectory();
    const generate = vi.fn()
      .mockRejectedValueOnce(new EsseApiError('Request rejected.', { code: 'bad_request', status: 400, chargeState: 'not_charged', origin: 'upstream' }))
      .mockResolvedValueOnce(generatedResult('manual-retry-success'));
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    await manager.initialize();
    const accepted = await manager.create({
      prompt: 'retry after fixing the surrounding configuration',
      requestKey: 'manual-non-auto-retry-request',
      approvedEstimatedCostMicros: 100_000,
    });
    await vi.waitFor(() => expect(manager.get(accepted.id).status).toBe('failed'));
    const job = manager.get(accepted.id).jobs[0];
    expect(job).toMatchObject({ retryable: false, chargeState: 'not_charged' });

    await manager.retry(accepted.id, [job.id]);

    await vi.waitFor(() => expect(manager.get(accepted.id).status).toBe('completed'));
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('automatically retries definitely-not-charged transient failures three times', async () => {
    const fixture = await fixtureDirectory();
    const generate = vi.fn(async () => {
      throw new EsseApiError('Provider is temporarily unavailable.', { code: 'provider_unavailable', status: 503, chargeState: 'not_charged', origin: 'upstream' });
    });
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    await manager.initialize();
    const accepted = await manager.create({
      prompt: 'safe retry',
      requestKey: 'safe-auto-retry-request',
      approvedEstimatedCostMicros: 100_000,
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(manager.get(accepted.id).status).toBe('failed'));
    const job = manager.get(accepted.id).jobs[0];
    expect(job).toMatchObject({ attempt: 4, chargeState: 'not_charged', retryable: true });
    expect(job.callHistory).toHaveLength(4);
    expect(job.callHistory.every((call) => call.chargeState === 'not_charged')).toBe(true);
    expect(job.callHistory.every((call) => call.errorOrigin === 'upstream')).toBe(true);
  });

  it('modifies a selected result in place and preserves its previous version', async () => {
    const fixture = await fixtureDirectory();
    const manager = managerFor(fixture, fakeApi());
    await manager.initialize();
    const created = await manager.create({
      prompt: 'original cat',
      requestKey: 'modify-original-request',
      approvedEstimatedCostMicros: 100_000,
    });
    await vi.waitFor(() => expect(manager.get(created.id).status).toBe('completed'));
    const originalId = manager.get(created.id).jobs[0].outputImageId!;

    await manager.modify({
      batchId: created.id,
      imageIds: [originalId],
      prompt: 'add a red scarf',
      requestKey: 'modify-red-scarf-request',
      approvedEstimatedCostMicros: 100_000,
    });
    await vi.waitFor(() => expect(manager.get(created.id).status).toBe('completed'));
    const modified = manager.get(created.id).jobs[0];
    expect(modified.outputImageId).not.toBe(originalId);
    expect(modified.backups).toEqual([expect.objectContaining({ name: '图1-1', imageId: originalId, prompt: 'original cat' })]);
  });

  it('keeps pasted or attached images as additional structural references during modification', async () => {
    const fixture = await fixtureDirectory();
    const api = fakeApi();
    const edit = vi.fn(api.edit);
    const manager = managerFor(fixture, { ...api, edit });
    await manager.initialize();
    const created = await manager.create({
      prompt: 'original flytrap',
      requestKey: 'modify-attachment-original',
    });
    await vi.waitFor(() => expect(manager.get(created.id).status).toBe('completed'));
    const originalId = manager.get(created.id).jobs[0].outputImageId!;
    const [background] = await fixture.imageStore.saveBatch({
      requestId: 'home-background-reference',
      prompt: 'user-provided home background',
      model: 'local-reference',
      items: [{ b64_json: testPng('home-background').toString('base64') }],
    });

    await manager.modify({
      batchId: created.id,
      imageIds: [originalId],
      referenceImageIds: [background.id],
      prompt: 'place the flytrap in the attached home interior',
      requestKey: 'modify-with-home-background',
    });
    await vi.waitFor(() => expect(manager.get(created.id).status).toBe('completed'));

    expect(manager.get(created.id).jobs[0].referenceImageIds).toEqual([originalId, background.id]);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it('creates a new job when a preserved backup is selected for modification', async () => {
    const fixture = await fixtureDirectory();
    const manager = managerFor(fixture, fakeApi());
    await manager.initialize();
    const created = await manager.create({
      prompt: 'original cat',
      requestKey: 'backup-source-create',
      approvedEstimatedCostMicros: 100_000,
    });
    await vi.waitFor(() => expect(manager.get(created.id).status).toBe('completed'));
    const originalId = manager.get(created.id).jobs[0].outputImageId!;
    await manager.modify({
      batchId: created.id,
      imageIds: [originalId],
      prompt: 'add a red scarf',
      requestKey: 'backup-source-first-edit',
      approvedEstimatedCostMicros: 100_000,
    });
    await vi.waitFor(() => expect(manager.get(created.id).status).toBe('completed'));
    const firstEditedId = manager.get(created.id).jobs[0].outputImageId!;

    await manager.modify({
      batchId: created.id,
      imageIds: [originalId],
      prompt: 'turn the original into a watercolor',
      requestKey: 'backup-source-second-edit',
      approvedEstimatedCostMicros: 100_000,
    });
    await vi.waitFor(() => expect(manager.get(created.id).jobs).toHaveLength(2));
    await vi.waitFor(() => expect(manager.get(created.id).status).toBe('completed'));
    const final = manager.get(created.id);
    expect(final.jobs[0].outputImageId).toBe(firstEditedId);
    expect(final.jobs[1]).toMatchObject({ name: '图2', referenceImageIds: [originalId], status: 'succeeded' });
  });

  it('runs appended jobs with their explicitly selected offering', async () => {
    const fixture = await fixtureDirectory();
    const generate = vi.fn(async (_input?: unknown, requestKey = 'generated') => generatedResult(requestKey.replace(/:/g, '-')));
    const api = {
      ...fakeApi(),
      offerings: async () => [
        { id: 'model-a', canonicalModelId: 'model-a', providerModelId: 'model-a', displayName: 'Model A', providerName: 'Provider A', providerType: 'tuzi-json-images', tierName: 'A', concurrency: 3, priceMicros: 100_000, currency: 'CNY', price: { mode: 'per_request' as const, currency: 'CNY', amount: 0.1 }, configured: true, sizes: [], supportsTextToImage: true, supportsImageToImage: true },
        { id: 'model-b', canonicalModelId: 'model-b', providerModelId: 'model-b', displayName: 'Model B', providerName: 'Provider B', providerType: 'openai-images', tierName: 'B', concurrency: 3, priceMicros: 200_000, currency: 'CNY', price: { mode: 'per_request' as const, currency: 'CNY', amount: 0.2 }, configured: true, sizes: [], supportsTextToImage: true, supportsImageToImage: true },
      ],
      generate,
    };
    const manager = managerFor(fixture, api);
    await manager.initialize();
    const created = await manager.create({
      prompt: 'first model',
      offeringId: 'model-a',
      requestKey: 'alternate-offering-create',
      approvedEstimatedCostMicros: 100_000,
    });
    await vi.waitFor(() => expect(manager.get(created.id).status).toBe('completed'));
    await manager.append({
      batchId: created.id,
      jobs: [{ prompt: 'second model' }],
      offeringId: 'model-b',
      requestKey: 'alternate-offering-append',
      approvedEstimatedCostMicros: 200_000,
    });
    await vi.waitFor(() => expect(manager.get(created.id).status).toBe('completed'));
    expect(generate.mock.calls.map(([input]) => (input as { model: string }).model)).toEqual(['model-a', 'model-b']);
    expect(manager.get(created.id).jobs[1].offering?.id).toBe('model-b');
  });

  it('keeps a failed WorkBuddy callback terminal instead of leaving the job running', async () => {
    const fixture = await fixtureDirectory();
    const generate = vi.fn(fakeApi().generate);
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    await manager.initialize();
    const created = await manager.create({
      prompt: 'WorkBuddy-owned image',
      offeringId: 'workbuddy-agent-generation',
      requestKey: 'agent-callback-failure',
      approvedEstimatedCostMicros: 0,
    });
    expect(created.jobs[0]).toMatchObject({ operation: 'agent', status: 'queued' });
    expect(generate).not.toHaveBeenCalled();
    await expect(manager.completeAgentJob(created.id, created.jobs[0].id, path.join(fixture.directory, 'missing.png'))).rejects.toThrow();
    const failedJob = manager.get(created.id).jobs[0];
    expect(failedJob).toMatchObject({ status: 'failed', chargeState: 'unknown', retryable: false, errorOrigin: 'esse' });
    await expect(manager.retry(created.id, [failedJob.id], true)).rejects.toThrow(/current Agent/i);
  });

  it('records an Agent-reported failure as upstream', async () => {
    const fixture = await fixtureDirectory();
    const manager = managerFor(fixture, fakeApi());
    await manager.initialize();
    const created = await manager.create({
      prompt: 'Agent-owned image',
      offeringId: 'workbuddy-agent-generation',
      requestKey: 'agent-reported-failure',
      approvedEstimatedCostMicros: 0,
    });

    const failed = await manager.failAgentJob(created.id, created.jobs[0].id, 'Agent generation failed.');

    expect(failed.jobs[0]).toMatchObject({ errorOrigin: 'upstream' });
    expect(failed.jobs[0].callHistory[0]).toMatchObject({ source: 'agent', errorOrigin: 'upstream' });
  });
});

async function fixtureDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-batch-manager-test-'));
  temporaryDirectories.push(directory);
  return {
    directory,
    imageStore: new ImageStore(directory),
    batchStore: new BatchStore(path.join(directory, 'batches')),
  };
}

function managerFor(
  fixture: Awaited<ReturnType<typeof fixtureDirectory>>,
  api: ReturnType<typeof fakeApi>,
  options: { concurrency?: number; canRun?: () => Promise<boolean> } = {},
) {
  const manager = new BatchManager({
    store: fixture.batchStore,
    imageStore: fixture.imageStore,
    createApiClient: async () => api,
    concurrency: options.concurrency,
    canRun: options.canRun,
  });
  managers.push(manager);
  return manager;
}

function fakeApi() {
  return {
    offerings: async () => [{
      id: 'gpt-image-2', canonicalModelId: 'gpt-image-2', providerModelId: 'gpt-image-2', displayName: 'gpt-image-2',
      providerName: 'Tuzi default', providerType: 'tuzi-json-images', tierName: '默认', concurrency: 3,
      priceMicros: 100_000, currency: 'CNY', price: { mode: 'per_request' as const, currency: 'CNY', amount: 0.1 }, configured: true,
      sizes: ['1024x1024'], supportsTextToImage: true, supportsImageToImage: true,
    }],
    generate: async (_input?: unknown, requestKey = 'generated') => generatedResult(requestKey.replace(/:/g, '-')),
    edit: async (_input?: unknown, _paths?: string[], requestKey = 'edited') => generatedResult(requestKey.replace(/:/g, '-')),
  };
}

function generatedResult(id: string) {
  return {
    requestId: id,
    items: [{ b64_json: testPng(`image-${id}`).toString('base64') }],
    reused: false,
  };
}

function testPng(content: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(content)]);
}
