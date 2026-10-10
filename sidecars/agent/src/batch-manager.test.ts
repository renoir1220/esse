import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EsseApiError, type ProviderTaskHooks } from './api-client';
import { BatchManager, type BatchManagerChange } from './batch-manager';
import { BatchStore } from './batch-store';
import { ImageStore } from './image-store';
import type { ProviderTaskState } from './types';

const temporaryDirectories: string[] = [];
const managers: BatchManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.waitForIdle()));
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('Esse batch manager', () => {
  it('restores, publishes, merges and individually deletes all final images without another paid request', async () => {
    const fixture = await pendingProviderFixture('result', 'charged');
    const record = (await fixture.batchStore.loadAll())[0];
    record.jobs[0].status = 'queued';
    await fixture.batchStore.save(record);
    const callId = record.jobs[0].callHistory[0].id;
    const result = generatedResult('accepted-request');
    result.items.push(...generatedResult('second').items, ...generatedResult('third').items);
    await fixture.batchStore.saveProviderResult(callId, result);
    const generate = vi.fn(fakeApi().generate);
    const changes: BatchManagerChange[] = [];
    const manager = managerFor(fixture, { ...fakeApi(), generate }, { onChanged: (change) => changes.push(change) });
    await manager.initialize();
    await manager.waitForIdle();
    const job = manager.get(fixture.batchId).jobs[0];
    expect(job.backups.map((image) => image.resultIndex)).toEqual([2, 3]);
    expect(job.backups.every((image) => image.providerCallId === callId)).toBe(true);
    expect(job.callHistory).toHaveLength(1);
    expect(changes.some((change) => change.type === 'upsert' && change.imageIds?.length === 3)).toBe(true);
    expect(await fixture.imageStore.list()).toHaveLength(3);
    const target = await manager.create({ prompt: 'merge target', requestKey: 'multiple-final-target' });
    await manager.waitForIdle();
    const merged = await manager.merge({ targetBatchId: target.id, sourceBatchIds: [fixture.batchId], requestKey: 'merge-multiple-finals' });
    const moved = merged.jobs[1];
    expect(moved.backups).toHaveLength(2);
    const extra = (await fixture.imageStore.get(moved.backups[0].imageId))!;
    await manager.deleteImages(merged.id, [extra.id]);
    expect(await fixture.imageStore.get(extra.id)).toBeUndefined();
    expect(manager.get(merged.id).jobs[1].backups).toHaveLength(1);
    await manager.deleteImages(merged.id, manager.get(merged.id).jobs.map((entry) => entry.outputImageId!));
    expect(await fixture.imageStore.list()).toHaveLength(0);
    await manager.deleteBatch(merged.id);
    expect(generate).toHaveBeenCalledTimes(1); // Only the explicitly created merge target.
  });

  for (const mode of ['result', 'task'] as const) for (const chargeState of ['unknown', 'charged'] as const) {
    it(`cancel queued ${mode} retrieval retains ${chargeState} and can retrieve again without submission`, async () => {
      const fixture = await pendingProviderFixture(mode, chargeState);
      let canRun = false;
      const generate = vi.fn(fakeApi().generate);
      const resume = vi.fn(fakeApi().resume);
      const manager = managerFor(fixture, { ...fakeApi(), generate, resume }, { canRun: async () => canRun });
      await manager.initialize();
      const pending = manager.retrieveTimedOut(fixture.batchId);
      await vi.waitFor(() => expect(manager.get(fixture.batchId).jobs[0].status).toBe('queued'));
      const canceled = await manager.cancelQueued(fixture.batchId);
      await pending;
      expect(canceled.jobs[0]).toMatchObject({ status: 'failed', chargeState, retryable: true, requestId: 'accepted-request', error: expect.stringContaining('Provider submission was not canceled') });
      expect(canceled.jobs[0].callHistory).toHaveLength(1);
      expect(canceled.jobs[0].callHistory[0].chargeState).toBe(chargeState);
      expect(generate).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      canRun = true;
      await manager.retrieveTimedOut(fixture.batchId);
      await manager.waitForIdle();
      expect(manager.get(fixture.batchId).jobs[0]).toMatchObject({ status: 'succeeded', requestId: 'accepted-request' });
      expect(manager.get(fixture.batchId).jobs[0].callHistory).toHaveLength(1);
      expect(generate).not.toHaveBeenCalled();
      expect(resume).toHaveBeenCalledTimes(mode === 'task' ? 1 : 0);
    });
  }

  it('resumes a queued result checkpoint after restart without another Provider request', async () => {
    const fixture = await pendingProviderFixture('result', 'charged');
    const [record] = await fixture.batchStore.loadAll();
    record.jobs[0].status = 'queued';
    record.jobs[0].hasProviderResult = false; // The private result is authoritative even before the marker is persisted.
    await fixture.batchStore.save(record);
    const generate = vi.fn(fakeApi().generate);
    const resume = vi.fn(fakeApi().resume);
    const restarted = managerFor(fixture, { ...fakeApi(), generate, resume });
    await restarted.initialize();
    await restarted.waitForIdle();
    expect(restarted.get(fixture.batchId).jobs[0]).toMatchObject({ status: 'succeeded', chargeState: 'charged', requestId: 'accepted-request' });
    expect(restarted.get(fixture.batchId).jobs[0].callHistory).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('keeps batch metadata when private result cleanup fails so deletion can be retried', async () => {
    const fixture = await pendingProviderFixture('result', 'unknown');
    const generate = vi.fn(fakeApi().generate);
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    await manager.initialize();
    const callId = manager.get(fixture.batchId).jobs[0].callHistory[0].id;
    vi.spyOn(fixture.batchStore, 'deleteProviderResult').mockRejectedValueOnce(new Error('injected result cleanup failure'));
    await expect(manager.deleteBatch(fixture.batchId)).rejects.toThrow('injected result cleanup');
    expect((await fixture.batchStore.loadAll()).map((batch) => batch.id)).toContain(fixture.batchId);
    expect(manager.get(fixture.batchId).jobs[0].chargeState).toBe('unknown');
    expect(await fixture.batchStore.loadProviderResult(callId)).toBeDefined();
    await manager.deleteBatch(fixture.batchId);
    expect(await fixture.batchStore.loadProviderResult(callId)).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it('preserves an already charged call when a repeated result download fails', async () => {
    const fixture = await pendingProviderFixture('result', 'charged');
    const generate = vi.fn(fakeApi().generate);
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    vi.spyOn(fixture.imageStore, 'saveBatch').mockRejectedValueOnce(new Error('download still unavailable'));
    await manager.initialize();
    await manager.retrieveTimedOut(fixture.batchId);
    await manager.waitForIdle();
    const failed = manager.get(fixture.batchId).jobs[0];
    expect(failed).toMatchObject({ status: 'failed', chargeState: 'charged', hasProviderResult: true });
    expect(failed.callHistory).toHaveLength(1);
    expect(failed.callHistory[0].chargeState).toBe('charged');
    expect(generate).not.toHaveBeenCalled();
  });

  it('retains synchronous results after a download failure and retrieves after restart without another paid request', async () => {
    const fixture = await fixtureDirectory();
    const privateUrl = 'https://cdn.provider.invalid/output.png?token=private-download-sentinel';
    const generate = vi.fn(async () => ({ ...generatedResult('sync-request-id'), items: [{ ...generatedResult('sync-request-id').items[0], url: privateUrl }] }));
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    const download = vi.spyOn(fixture.imageStore, 'saveBatch').mockRejectedValueOnce(new Error('Could not download generated image (HTTP 403).'));
    await manager.initialize();
    const accepted = await manager.create({ prompt: 'sync result', requestKey: 'sync-result' });
    await manager.waitForIdle();
    const failed = manager.get(accepted.id);
    expect(failed.jobs[0]).toMatchObject({ status: 'failed', chargeState: 'unknown', requestId: 'sync-request-id', hasProviderResult: true, error: expect.stringContaining('HTTP 403') });
    expect(JSON.stringify(failed)).not.toContain(privateUrl);
    const callId = failed.jobs[0].callHistory[0].id;
    expect(await fixture.batchStore.loadProviderResult(callId)).toMatchObject({ requestId: 'sync-request-id', items: [expect.objectContaining({ url: privateUrl })] });
    download.mockRestore();
    const restarted = managerFor(fixture, { ...fakeApi(), generate });
    await restarted.initialize();
    await restarted.retrieveTimedOut(accepted.id);
    await restarted.waitForIdle();
    expect(restarted.get(accepted.id).jobs[0]).toMatchObject({ status: 'succeeded', requestId: 'sync-request-id', hasProviderResult: false });
    expect(restarted.get(accepted.id).jobs[0].callHistory).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await fixture.batchStore.loadProviderResult(callId)).toBeUndefined();
  });

  it('never regenerates when a saved result checkpoint is missing', async () => {
    const fixture = await fixtureDirectory();
    const generate = vi.fn(async () => generatedResult('lost-checkpoint-request'));
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    vi.spyOn(fixture.imageStore, 'saveBatch').mockRejectedValueOnce(new Error('download unavailable'));
    await manager.initialize();
    const accepted = await manager.create({ prompt: 'missing checkpoint', requestKey: 'missing-checkpoint' });
    await manager.waitForIdle();
    await fixture.batchStore.deleteProviderResult(manager.get(accepted.id).jobs[0].callHistory[0].id);
    await manager.retrieveTimedOut(accepted.id);
    await manager.waitForIdle();
    expect(manager.get(accepted.id).jobs[0]).toMatchObject({ status: 'failed', chargeState: 'unknown', error: expect.stringContaining('no new generation') });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('isolates a corrupt result checkpoint after a crash without exposing its contents or resubmitting', async () => {
    const fixture = await fixtureDirectory();
    const generate = vi.fn(async () => generatedResult('corrupt-checkpoint-request'));
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    vi.spyOn(fixture.imageStore, 'saveBatch').mockRejectedValueOnce(new Error('download unavailable'));
    await manager.initialize();
    const accepted = await manager.create({ prompt: 'corrupt checkpoint', requestKey: 'corrupt-checkpoint' });
    await manager.waitForIdle();
    const [record] = await fixture.batchStore.loadAll();
    const job = record.jobs[0];
    const callId = job.callHistory[0].id;
    await writeFile(path.join(fixture.directory, 'batches', '.provider-results', `${callId}.json`), 'private-url-sentinel: malformed JSON');
    job.status = 'running';
    job.hasProviderResult = false;
    await fixture.batchStore.save(record);
    const restarted = managerFor(fixture, { ...fakeApi(), generate });
    await restarted.initialize();
    await restarted.waitForIdle();
    expect(restarted.get(accepted.id).jobs[0]).toMatchObject({ status: 'failed', chargeState: 'unknown', error: expect.stringContaining('could not be read') });
    expect(JSON.stringify(restarted.get(accepted.id))).not.toContain('private-url-sentinel');
    expect(generate).toHaveBeenCalledTimes(1);
    await restarted.deleteBatch(accepted.id);
    expect(await fixture.batchStore.loadProviderResult(callId)).toBeUndefined();
  });

  it('upgrades legacy keep-source merge replays without cloning again', async () => {
    const fixture = await fixtureDirectory();
    const api = fakeApi();
    const manager = managerFor(fixture, api);
    await manager.initialize();
    const target = await manager.create({ prompt: 'target', requestKey: 'legacy-target' });
    const sourceInput = { prompt: 'source', requestKey: 'legacy-source' };
    const source = await manager.create(sourceInput);
    await manager.waitForIdle();
    const records = await fixture.batchStore.loadAll();
    const sourceRecord = records.find((batch) => batch.id === source.id)!;
    const input = { targetBatchId: target.id, sourceBatchIds: [source.id], requestKey: 'legacy-merge', deleteSourceBatches: false };
    await manager.merge(input);
    const moved = (await fixture.batchStore.loadAll())[0];
    delete moved.mergeFingerprints;
    delete moved.createAliases;
    await fixture.batchStore.save(moved);
    await fixture.batchStore.save(sourceRecord);
    const restarted = managerFor(fixture, api);
    await restarted.initialize();
    expect(restarted.list()).toHaveLength(2);
    expect((await restarted.merge(input)).jobs).toHaveLength(2);
    expect(restarted.list()).toHaveLength(1);
    expect((await restarted.create(sourceInput)).id).toBe(target.id);
    expect((await fixture.batchStore.loadAll()).map((batch) => batch.id)).toEqual([target.id]);
  });
  it('moves completed jobs, backups, images and history, remaps create keys and supports deletion after restart', async () => {
    const fixture = await fixtureDirectory();
    const api = fakeApi();
    const manager = managerFor(fixture, api);
    await manager.initialize();
    const target = await manager.create({ prompt: 'target', requestKey: 'merge-target-create' });
    const sourceInput = { prompt: 'source', requestKey: 'merge-source-create' };
    const source = await manager.create(sourceInput);
    await manager.waitForIdle();
    const original = manager.get(source.id).jobs[0].outputImageId!;
    await manager.modify({ batchId: source.id, imageIds: [original], prompt: 'changed source', requestKey: 'merge-source-modify' });
    await manager.waitForIdle();
    const before = manager.get(source.id).jobs[0];
    const folder = await fixture.imageStore.prepareBatchFolder(source.id, source.title, [{ id: before.outputImageId!, name: before.name }]);
    const merged = await manager.merge({ targetBatchId: target.id, sourceBatchIds: [source.id], requestKey: 'merge-move-key', deleteSourceBatches: false });
    expect(manager.list()).toHaveLength(1);
    expect(merged.jobs[1]).toMatchObject({ outputImageId: before.outputImageId, backups: before.backups, callHistory: before.callHistory });
    await expect(access(folder)).rejects.toThrow();
    expect((await manager.create(sourceInput)).id).toBe(target.id);
    const restarted = managerFor(fixture, api);
    await restarted.initialize();
    expect(restarted.list()).toHaveLength(1);
    expect((await restarted.create(sourceInput)).id).toBe(target.id);
    expect((await restarted.merge({ targetBatchId: target.id, sourceBatchIds: [source.id], requestKey: 'merge-move-key', deleteSourceBatches: true })).jobs).toHaveLength(2);
    await restarted.deleteImages(target.id, [before.backups[0].imageId]);
    expect(await fixture.imageStore.get(before.backups[0].imageId)).toBeUndefined();
    expect(await fixture.imageStore.get(before.outputImageId!)).toBeDefined();
  });

  it.each(['commit', 'cleanup', 'receipt'])('recovers a merge when %s persistence fails', async (stage) => {
    const fixture = await fixtureDirectory();
    const api = fakeApi();
    const manager = managerFor(fixture, api);
    await manager.initialize();
    const target = await manager.create({ prompt: 'target', requestKey: `target-${stage}-create` });
    const sourceInput = { prompt: 'source', requestKey: `source-${stage}-create` };
    const source = await manager.create(sourceInput);
    await manager.waitForIdle();
    const save = fixture.batchStore.save.bind(fixture.batchStore);
    let failed = false;
    const saveSpy = vi.spyOn(fixture.batchStore, 'save').mockImplementation(async (batch) => {
      const matches = stage === 'commit' ? Boolean(batch.mergeCleanup?.length) : stage === 'receipt' && batch.id === target.id && batch.jobs.length === 2 && !batch.mergeCleanup;
      if (!failed && matches) { failed = true; throw new Error(`injected ${stage} merge failure`); }
      await save(batch);
    });
    const deleteSpy = vi.spyOn(fixture.batchStore, 'delete').mockImplementationOnce(async () => { if (stage === 'cleanup') { failed = true; throw new Error('injected cleanup merge failure'); } });
    const input = { targetBatchId: target.id, sourceBatchIds: [source.id], requestKey: `merge-${stage}-key` };
    await expect(manager.merge(input)).rejects.toThrow(/injected/);
    expect(manager.list()).toHaveLength(stage === 'commit' ? 2 : 1);
    if (stage === 'commit') expect(manager.get(target.id).jobs).toHaveLength(1);
    saveSpy.mockRestore();
    deleteSpy.mockRestore();
    const restarted = managerFor(fixture, api);
    await restarted.initialize();
    const merged = await restarted.merge(input);
    expect(merged.jobs).toHaveLength(2);
    expect(restarted.list()).toHaveLength(1);
    expect((await fixture.batchStore.loadAll()).map((batch) => batch.id)).toEqual([target.id]);
    expect((await restarted.create(sourceInput)).id).toBe(target.id);
  });

  it('deduplicates concurrent create and append before offering resolution and rejects conflicting keys', async () => {
    const fixture = await fixtureDirectory();
    const api = fakeApi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalOfferings = api.offerings;
    const offerings = vi.spyOn(api, 'offerings').mockImplementation(async () => { await gate; return originalOfferings(); });
    const manager = managerFor(fixture, api, { canRun: async () => false });
    await manager.initialize();
    const input = { prompt: 'one durable batch', requestKey: 'concurrent-create-key' };
    const pending = [manager.create(input), manager.create({ ...input })];
    await expect(manager.create({ ...input, prompt: 'different' })).rejects.toThrow(/different arguments/);
    release();
    const [first, second] = await Promise.all(pending);
    expect(first.id).toBe(second.id);
    expect(offerings).toHaveBeenCalledTimes(1);
    expect(manager.list()).toHaveLength(1);
    const append = { batchId: first.id, requestKey: 'concurrent-append-key', jobs: [{ prompt: 'one appended job' }] };
    const appended = await Promise.all([manager.append(append), manager.append({ ...append })]);
    expect(appended[0].appendedJobIds).toEqual(appended[1].appendedJobIds);
    expect(manager.get(first.id).jobs).toHaveLength(2);
    await expect(manager.append({ ...append, jobs: [{ prompt: 'different' }] })).rejects.toThrow(/different arguments/);
    const restarted = managerFor(fixture, api, { canRun: async () => false });
    await restarted.initialize();
    await expect(restarted.create({ ...input, prompt: 'different after restart' })).rejects.toThrow(/different arguments/);
    await expect(restarted.append({ ...append, jobs: [{ prompt: 'different after restart' }] })).rejects.toThrow(/different arguments/);
    const generate = vi.spyOn(api, 'generate');
    const runner = managerFor(fixture, api);
    await runner.initialize();
    await runner.waitForIdle();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(runner.get(first.id).jobs.map((job) => job.status)).toEqual(['succeeded', 'succeeded']);
  });

  it.each(['start', 'task', 'finish'])('releases running bookkeeping when %s persistence fails', async (stage) => {
    const fixture = await fixtureDirectory();
    const api = fakeApi(1);
    const now = new Date().toISOString();
    api.generate = vi.fn(async (_input?: unknown, requestKey = 'generated', hooks?: ProviderTaskHooks) => {
      await hooks?.onTask?.({ id: 'accepted-task', protocol: 'tuzi-video', status: 'in_progress', submittedAt: now, updatedAt: now });
      return generatedResult(requestKey);
    });
    let canRun = false;
    const manager = managerFor(fixture, api, { canRun: async () => canRun });
    await manager.initialize();
    const created = await manager.create({ prompt: 'failure injection', requestKey: `failure-${stage}-key` });
    const save = fixture.batchStore.save.bind(fixture.batchStore);
    let injected = false;
    vi.spyOn(fixture.batchStore, 'save').mockImplementation(async (batch) => {
      const job = batch.jobs[0];
      const matches = stage === 'start' ? job.status === 'running' && !job.providerTask
        : stage === 'task' ? job.status === 'running' && Boolean(job.providerTask) : job.status === 'succeeded';
      if (!injected && matches) { injected = true; throw new Error(`injected ${stage} save failure`); }
      await save(batch);
    });
    canRun = true;
    manager.resume();
    if (stage === 'finish') await expect(manager.waitForIdle()).rejects.toThrow(/injected finish/);
    else await manager.waitForIdle();
    expect(injected).toBe(true);
    expect(manager.get(created.id).jobs[0].status).not.toBe('running');
    const next = await manager.create({ prompt: 'queue continues', requestKey: `after-${stage}-failure-key` });
    await manager.waitForIdle();
    expect(manager.get(next.id).jobs[0].status).toBe('succeeded');
    if (stage === 'start') expect(api.generate).toHaveBeenCalledTimes(1);
  });

  for (const targetKind of ['result', 'backup'] as const) it(`does not retain or later execute a ${targetKind} edit after its save fails`, async () => {
    const fixture = await fixtureDirectory();
    const edit = vi.fn(fakeApi().edit);
    const manager = managerFor(fixture, { ...fakeApi(), edit });
    await manager.initialize();
    const created = await manager.create({ prompt: 'mother', requestKey: 'save-failure-mother' });
    await manager.waitForIdle();
    if (targetKind === 'backup') {
      await manager.modify({ batchId: created.id, imageIds: [manager.get(created.id).jobs[0].outputImageId!], prompt: 'seed backup', requestKey: 'save-failure-backup' });
      await manager.waitForIdle();
    }
    const before = manager.get(created.id);
    const editCalls = edit.mock.calls.length;
    const imageId = targetKind === 'backup' ? before.jobs[0].backups[0].imageId : before.jobs[0].outputImageId!;
    vi.spyOn(fixture.batchStore, 'save').mockRejectedValueOnce(new Error('injected disk-save failure'));
    await expect(manager.modify({ batchId: created.id, imageIds: [imageId], prompt: 'must not escape', requestKey: 'parent-failed-save' })).rejects.toThrow('injected disk-save failure');
    expect(manager.get(created.id)).toEqual(before);
    expect(manager.list('parent-failed-save')).toEqual([]);
    const disk = (await fixture.batchStore.loadAll()).find(batch => batch.id === created.id)!;
    expect(disk.jobs).toEqual(before.jobs);
    expect(disk.modificationKeys).not.toHaveProperty('parent-failed-save');
    await manager.create({ prompt: 'unrelated', requestKey: 'after-failed-edit' });
    await manager.waitForIdle();
    expect(edit).toHaveBeenCalledTimes(editCalls);
    expect(manager.get(created.id)).toEqual(before);
  });

  it('keeps an uncommitted edit invisible while unrelated work can run', async () => {
    const fixture = await fixtureDirectory();
    const edit = vi.fn(fakeApi().edit);
    const manager = managerFor(fixture, { ...fakeApi(), edit });
    await manager.initialize();
    const created = await manager.create({ prompt: 'mother', requestKey: 'pending-save-mother' });
    await manager.waitForIdle();
    const before = manager.get(created.id);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const save = fixture.batchStore.save.bind(fixture.batchStore);
    vi.spyOn(fixture.batchStore, 'save').mockImplementation(async batch => {
      if (Object.hasOwn(batch.modificationKeys, 'pending-save-edit')) {
        entered = true;
        await barrier;
        throw new Error('injected delayed save failure');
      }
      await save(batch);
    });
    const failed = expect(manager.modify({ batchId: created.id, imageIds: [before.jobs[0].outputImageId!], prompt: 'pending edit', requestKey: 'pending-save-edit' })).rejects.toThrow('injected delayed save failure');
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(manager.get(created.id)).toEqual(before);
      expect(manager.list('pending-save-edit')).toEqual([]);
      const unrelated = await manager.create({ prompt: 'unrelated', requestKey: 'during-pending-edit' });
      await manager.waitForIdle();
      expect(manager.get(unrelated.id).status).toBe('completed');
      expect(edit).not.toHaveBeenCalled();
    } finally { release(); await failed; }
    expect(manager.get(created.id)).toEqual(before);
  });

  it('publishes a batch-local change after durable acceptance', async () => {
    const fixture = await fixtureDirectory();
    const changes: BatchManagerChange[] = [];
    const manager = managerFor(fixture, fakeApi(), { canRun: async () => false, onChanged: (change) => { changes.push(change); } });
    await manager.initialize();

    const accepted = await manager.create({ prompt: 'local change', requestKey: 'batch-local-change' });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: 'upsert', batch: { id: accepted.id, status: 'queued' } });
    expect(changes[0]).not.toHaveProperty('images');
    expect(changes[0]).not.toHaveProperty('batches');
  });

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
    const manager = managerFor(fixture, { ...fakeApi(2), generate });
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

  it('uses a bounded default and gives each batch a scheduling turn', async () => {
    const fixture = await fixtureDirectory();
    let runnable = false;
    const pending: Array<(value: ReturnType<typeof generatedResult>) => void> = [];
    const generate = vi.fn((_input?: unknown) => new Promise<ReturnType<typeof generatedResult>>((resolve) => pending.push(resolve)));
    const manager = managerFor(fixture, { ...fakeApi(), generate }, { canRun: async () => runnable });
    await manager.initialize();
    await manager.create({
      title: 'First batch',
      jobs: [{ prompt: 'first-1' }, { prompt: 'first-2' }, { prompt: 'first-3' }],
      requestKey: 'bounded-first-batch',
    });
    await manager.create({
      title: 'Second batch',
      jobs: [{ prompt: 'second-1' }],
      requestKey: 'bounded-second-batch',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    runnable = true;
    manager.resume();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(3));

    const prompts = generate.mock.calls.map(([input]) => (input as { prompt: string }).prompt);
    expect(new Set(prompts.slice(0, 2))).toEqual(new Set(['first-1', 'second-1']));
    expect(prompts[2]).toBe('first-2');
    pending.splice(0).forEach((resolve, index) => resolve(generatedResult(`bounded-${index}`)));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(4));
    pending.splice(0).forEach((resolve) => resolve(generatedResult('bounded-final')));
  });

  it('lets the configured Provider concurrency control execution without a hidden global cap', async () => {
    const fixture = await fixtureDirectory();
    const pending: Array<(value: ReturnType<typeof generatedResult>) => void> = [];
    const generate = vi.fn(() => new Promise<ReturnType<typeof generatedResult>>((resolve) => pending.push(resolve)));
    const manager = managerFor(fixture, { ...fakeApi(10), generate });
    await manager.initialize();

    const accepted = await manager.create({
      title: 'Ten configured jobs',
      jobs: Array.from({ length: 10 }, (_, index) => ({ prompt: `configured-${index + 1}` })),
      requestKey: 'configured-provider-concurrency',
    });

    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(10));
    expect(manager.get(accepted.id)).toMatchObject({ running: 10, queued: 0 });
    pending.splice(0).forEach((resolve, index) => resolve(generatedResult(`configured-${index}`)));
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

  it('resumes an accepted Tuzi task by task ID after Esse restarts without submitting again', async () => {
    const fixture = await fixtureDirectory();
    const first = managerFor(fixture, fakeApi(), { canRun: async () => false });
    await first.initialize();
    const accepted = await first.create({ prompt: 'resume accepted task', requestKey: 'resume-accepted-provider-task' });
    const [record] = await fixture.batchStore.loadAll();
    const job = record.jobs[0];
    const now = new Date().toISOString();
    const providerTask = { id: 'task-resume-1', status: 'in_progress' as const, progress: 10, requestId: 'request-resume-1', submittedAt: now, startedAt: now, updatedAt: now };
    Object.assign(job, { status: 'running', progress: 10, chargeState: 'unknown', startedAt: now, providerTask });
    job.callHistory = [{ id: 'call-resume-1', sequence: 1, attempt: 1, source: 'provider', offering: job.offering || record.offering, status: 'running', chargeState: 'unknown', startedAt: now, providerTask }];
    await fixture.batchStore.save(record);

    const generate = vi.fn(fakeApi().generate);
    const resume = vi.fn(async (_input?: unknown, task?: ProviderTaskState, hooks?: ProviderTaskHooks) => {
      await hooks?.onTask?.({ ...task!, status: 'completed', progress: undefined, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return generatedResult('resumed-task');
    });
    const restarted = managerFor(fixture, { ...fakeApi(), generate, resume });
    await restarted.initialize();

    await vi.waitFor(() => expect(restarted.get(accepted.id).status).toBe('completed'));
    expect(generate).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'task-resume-1' }), expect.anything());
    expect(restarted.get(accepted.id).jobs[0].callHistory).toHaveLength(1);
  });

  it('retrieves timed-out Provider tasks without submitting duplicates', async () => {
    const fixture = await fixtureDirectory();
    const first = managerFor(fixture, fakeApi(), { canRun: async () => false });
    await first.initialize();
    const accepted = await first.create({ prompt: 'retrieve timed out', requestKey: 'retrieve-timed-out' });
    const [record] = await fixture.batchStore.loadAll();
    const job = record.jobs[0];
    const now = new Date().toISOString();
    job.status = 'failed';
    job.chargeState = 'unknown';
    job.retryable = true;
    job.providerTask = { id: 'task-timeout-1', status: 'in_progress', progress: 30, submittedAt: now, updatedAt: now };
    await fixture.batchStore.save(record);
    const resume = vi.fn(async (_input?: unknown, task?: ProviderTaskState, hooks?: ProviderTaskHooks) => {
      await hooks?.onTask?.({ ...task!, status: 'completed', progress: 100, updatedAt: new Date().toISOString() });
      return generatedResult('retrieved');
    });
    const manager = managerFor(fixture, { ...fakeApi(), resume });
    await manager.initialize();
    const queued = await manager.retrieveTimedOut(accepted.id);
    expect(['queued', 'running', 'succeeded']).toContain(queued.jobs[0].status);
    expect(queued.jobs[0]).toMatchObject({ providerTask: { id: 'task-timeout-1' } });
    manager.resume();
    await vi.waitFor(() => expect(manager.get(accepted.id).status).toBe('completed'));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ singleQuery: true, signal: expect.any(AbortSignal) }));
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

  it('ends manual retrieval after one minute even when work cannot start', async () => {
    const fixture = await fixtureDirectory();
    const first = managerFor(fixture, fakeApi(), { canRun: async () => false });
    await first.initialize();
    const accepted = await first.create({ prompt: 'blocked retrieval', requestKey: 'blocked-retrieval' });
    const [record] = await fixture.batchStore.loadAll();
    Object.assign(record.jobs[0], { status: 'failed', chargeState: 'unknown', providerTask: { id: 'pending-task', protocol: 'tuzi-video', status: 'queued', submittedAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' } });
    await fixture.batchStore.save(record);
    const manager = managerFor(fixture, fakeApi(), { canRun: async () => false });
    await manager.initialize();
    vi.useFakeTimers();
    try {
      const result = manager.retrieveTimedOut(accepted.id);
      await vi.waitFor(() => expect(manager.get(accepted.id).jobs[0].status).toBe('queued'));
      await vi.advanceTimersByTimeAsync(60_100);
      // Filesystem persistence can finish after the clock advance.
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(100); expect(manager.get(accepted.id).jobs[0].status).toBe('failed'); });
      await expect(result).resolves.toMatchObject({ jobs: [expect.objectContaining({ status: 'failed', chargeState: 'unknown', providerTask: expect.objectContaining({ id: 'pending-task' }), error: expect.stringContaining('1 分钟') })] });
    } finally { vi.useRealTimers(); }
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

  it('reports a definitely-not-charged transient failure without automatic retries', async () => {
    const fixture = await fixtureDirectory();
    const generate = vi.fn(async () => {
      throw new EsseApiError('Provider is temporarily unavailable.', { code: 'provider_unavailable', status: 503, chargeState: 'not_charged', origin: 'upstream' });
    });
    const manager = managerFor(fixture, { ...fakeApi(), generate });
    await manager.initialize();
    const accepted = await manager.create({
      prompt: 'safe retry',
      requestKey: 'no-auto-retry-request',
      approvedEstimatedCostMicros: 100_000,
    });
    await vi.waitFor(() => expect(manager.get(accepted.id).status).toBe('failed'));
    const job = manager.get(accepted.id).jobs[0];
    expect(generate).toHaveBeenCalledTimes(1);
    expect(job).toMatchObject({ attempt: 1, chargeState: 'not_charged', retryable: true });
    expect(job.callHistory).toHaveLength(1);
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

async function pendingProviderFixture(mode: 'result' | 'task', chargeState: 'unknown' | 'charged') {
  const fixture = await fixtureDirectory();
  const seed = managerFor(fixture, fakeApi(), { canRun: async () => false });
  await seed.initialize();
  const created = await seed.create({ prompt: 'accepted Provider request', requestKey: 'pending-provider-request' });
  await seed.waitForIdle();
  const [record] = await fixture.batchStore.loadAll();
  const job = record.jobs[0];
  const now = new Date().toISOString();
  Object.assign(job, { status: 'failed', chargeState, retryable: true, requestId: 'accepted-request', hasProviderResult: mode === 'result', startedAt: now });
  job.callHistory = [{ id: `accepted-call-${mode}`, sequence: 1, attempt: 1, source: 'provider', offering: record.offering, status: 'failed', chargeState, startedAt: now, requestId: 'accepted-request' }];
  if (mode === 'result') await fixture.batchStore.saveProviderResult(job.callHistory[0].id, generatedResult('accepted-request'));
  else job.providerTask = { id: 'accepted-request', protocol: 'tuzi-video', status: 'in_progress', requestId: 'accepted-request', submittedAt: now, updatedAt: now };
  await fixture.batchStore.save(record);
  return { ...fixture, batchId: created.id };
}

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
  options: { canRun?: () => Promise<boolean>; onChanged?: (change: BatchManagerChange) => void } = {},
) {
  const manager = new BatchManager({
    store: fixture.batchStore,
    imageStore: fixture.imageStore,
    createApiClient: async () => api,
    canRun: options.canRun,
    onChanged: options.onChanged,
  });
  managers.push(manager);
  return manager;
}

function fakeApi(concurrency = 3) {
  return {
    offerings: async () => [{
      id: 'gpt-image-2', canonicalModelId: 'gpt-image-2', providerModelId: 'gpt-image-2', displayName: 'gpt-image-2',
      providerName: 'Tuzi default', providerType: 'tuzi-json-images', tierName: '默认', concurrency,
      priceMicros: 100_000, currency: 'CNY', price: { mode: 'per_request' as const, currency: 'CNY', amount: 0.1 }, configured: true,
      sizes: ['1024x1024'], supportsTextToImage: true, supportsImageToImage: true,
    }],
    generate: async (_input?: unknown, requestKey = 'generated') => generatedResult(requestKey.replace(/:/g, '-')),
    edit: async (_input?: unknown, _paths?: string[], requestKey = 'edited') => generatedResult(requestKey.replace(/:/g, '-')),
    resume: async (_input?: unknown, task?: ProviderTaskState, _hooks?: ProviderTaskHooks) => generatedResult(task?.id || 'resumed'),
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
