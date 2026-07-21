import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { EsseApiError, type ApiGenerateResult, type EsseApiClient } from './api-client';
import type { BatchStore } from './batch-store';
import type { ImageStore } from './image-store';
import {
  type AppendBatchInput,
  type BatchJob,
  type BatchRecord,
  type BatchSnapshot,
  type CreateBatchInput,
  type ModifyBatchInput,
  type OfferingSummary,
  type SavedImage,
  WORKBUDDY_AGENT_OFFERING,
} from './types';

const MAX_BATCH_IMAGES = 50;
const MAX_REFERENCE_IMAGES = 20;
const DEFAULT_CONCURRENCY = 3;
const AUTO_RETRY_LIMIT = 3;

type ApiClient = Pick<EsseApiClient, 'offerings' | 'generate' | 'edit'>;
type ResolvedBatchImage =
  | { kind: 'result'; job: BatchJob; imageId: string }
  | { kind: 'backup'; job: BatchJob; imageId: string }
  | { kind: 'failed-source'; job: BatchJob; imageId: string };

export interface BatchManagerOptions {
  store: BatchStore;
  imageStore: ImageStore;
  createApiClient: () => Promise<ApiClient>;
  canRun?: () => Promise<boolean>;
  concurrency?: number;
  getDefaultOfferingId?: () => Promise<string | undefined>;
  onChanged?: () => void | Promise<void>;
}

export class BatchManager {
  private readonly batches = new Map<string, BatchRecord>();
  private readonly createKeys = new Map<string, string>();
  private readonly activeJobs = new Set<string>();
  private readonly agentCompletionChains = new Map<string, Promise<BatchSnapshot>>();
  private activeBatchId: string | undefined;
  private initialized = false;
  private scheduling = false;

  constructor(private readonly options: BatchManagerOptions) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    for (const raw of await this.options.store.loadAll()) {
      const batch = normalizeBatch(raw);
      let changed = false;
      for (const job of batch.jobs) {
        if (job.status === 'running') {
          const finished = Date.now();
          const started = job.startedAt ? new Date(job.startedAt).getTime() : finished;
          job.status = 'failed';
          job.progress = 100;
          job.retryable = false;
          job.chargeState = 'unknown';
          job.error = job.operation === 'agent'
            ? 'Esse stopped while the Agent-owned task was running. It was not restarted automatically.'
            : 'Esse stopped while this Provider request was running. Its charge state is unknown, so it was not retried.';
          job.finishedAt = new Date(finished).toISOString();
          job.durationMs = Math.max(0, finished - started);
          changed = true;
        }
      }
      this.batches.set(batch.id, batch);
      if (batch.requestKey) this.createKeys.set(batch.requestKey, batch.id);
      if (changed) await this.options.store.save(batch);
    }
    await this.importLegacyImages();
    this.activeBatchId = this.list()[0]?.id;
    this.initialized = true;
    this.schedule();
  }

  list(): BatchSnapshot[] {
    return [...this.batches.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(snapshot);
  }

  get(id: string): BatchSnapshot {
    const batch = this.requiredBatch(id);
    return snapshot(batch);
  }

  getActiveId(): string | undefined {
    return this.activeBatchId;
  }

  resume(): void {
    this.schedule();
  }

  async activate(id: string): Promise<BatchSnapshot> {
    const batch = this.requiredBatch(id);
    this.activeBatchId = id;
    await this.changed();
    return snapshot(batch);
  }

  async offerings(): Promise<OfferingSummary[]> {
    const client = await this.options.createApiClient();
    return [...await client.offerings(), structuredClone(WORKBUDDY_AGENT_OFFERING)];
  }

  async create(input: CreateBatchInput): Promise<BatchSnapshot> {
    assertRequestKey(input.requestKey);
    const existingId = this.createKeys.get(input.requestKey);
    if (existingId) return this.get(existingId);
    const definitions = normalizedJobs(input);
    if (definitions.length > MAX_BATCH_IMAGES) throw new Error(`A batch may contain at most ${MAX_BATCH_IMAGES} images.`);
    const offering = await this.resolveOffering(input.offeringId);
    assertLegacyEstimate(offering, definitions.length, input.approvedEstimatedCostMicros);
    const now = new Date().toISOString();
    const batch: BatchRecord = {
      id: randomUUID(),
      requestKey: input.requestKey,
      appendKeys: {},
      modificationKeys: {},
      mergeKeys: {},
      title: cleanTitle(input.title || definitions[0]?.prompt || '新图片批次'),
      prompt: input.prompt?.trim() || definitions[0]?.prompt || '',
      offering,
      jobs: definitions.map((definition, index) => makeJob({
        index,
        prompt: definition.prompt,
        referenceImageIds: definition.referenceImageIds,
        requestKey: derivedRequestKey(input.requestKey, `create:${index}`),
        operation: operationFor(offering, 'generate'),
        size: input.size,
        quality: input.quality,
        now,
      })),
      createdAt: now,
      updatedAt: now,
    };
    await this.assertImagesExist(batch.jobs.flatMap((job) => job.referenceImageIds));
    await this.options.store.save(batch);
    this.batches.set(batch.id, batch);
    this.createKeys.set(input.requestKey, batch.id);
    this.activeBatchId = batch.id;
    await this.changed();
    this.schedule();
    return snapshot(batch);
  }

  async append(input: AppendBatchInput): Promise<{ batch: BatchSnapshot; appendedJobIds: string[] }> {
    assertRequestKey(input.requestKey);
    const batch = this.requiredBatch(input.batchId);
    const existing = batch.appendKeys[input.requestKey];
    if (existing) return { batch: snapshot(batch), appendedJobIds: existing };
    if (!input.jobs.length || input.jobs.length > MAX_BATCH_IMAGES) throw new Error('Provide between 1 and 50 jobs.');
    for (const job of input.jobs) assertReferenceCount(job.referenceImageIds ?? []);
    if (batch.jobs.length + input.jobs.length > MAX_BATCH_IMAGES) throw new Error(`A batch may contain at most ${MAX_BATCH_IMAGES} images.`);
    const offering = input.offeringId ? await this.resolveOffering(input.offeringId) : batch.offering;
    assertLegacyEstimate(offering, input.jobs.length, input.approvedEstimatedCostMicros);
    await this.assertImagesExist(input.jobs.flatMap((job) => job.referenceImageIds ?? []));
    const now = new Date().toISOString();
    const appended = input.jobs.map((definition, offset) => makeJob({
      index: batch.jobs.length + offset,
      prompt: requiredPrompt(definition.prompt),
      referenceImageIds: unique(definition.referenceImageIds ?? []),
      requestKey: derivedRequestKey(input.requestKey, `append:${offset}`),
      operation: operationFor(offering, 'generate'),
      offering,
      size: input.size,
      quality: input.quality,
      now,
    }));
    batch.jobs.push(...appended);
    batch.appendKeys[input.requestKey] = appended.map((job) => job.id);
    batch.updatedAt = now;
    await this.options.store.save(batch);
    this.activeBatchId = batch.id;
    await this.changed();
    this.schedule();
    return { batch: snapshot(batch), appendedJobIds: appended.map((job) => job.id) };
  }

  async modify(input: ModifyBatchInput): Promise<{ batch: BatchSnapshot; modifiedJobIds: string[] }> {
    assertRequestKey(input.requestKey);
    const batch = this.requiredBatch(input.batchId);
    const existing = batch.modificationKeys[input.requestKey];
    if (existing) return { batch: snapshot(batch), modifiedJobIds: existing };
    const imageIds = unique(input.imageIds);
    if (!imageIds.length || imageIds.length > MAX_BATCH_IMAGES) throw new Error('Select between 1 and 50 images.');
    const additionalReferenceImageIds = unique(input.referenceImageIds ?? []);
    assertReferenceCount(additionalReferenceImageIds);
    const offering = input.offeringId ? await this.resolveOffering(input.offeringId) : batch.offering;
    if (!offering.supportsImageToImage) throw new Error(`${offering.displayName} does not support image editing.`);
    assertLegacyEstimate(offering, imageIds.length, input.approvedEstimatedCostMicros);
    const prompt = requiredPrompt(input.prompt);
    const targets = imageIds.map((imageId) => this.resolveBatchImage(batch, imageId));
    for (const target of targets) assertReferenceCount(unique([target.imageId, ...additionalReferenceImageIds]));
    await this.assertImagesExist(additionalReferenceImageIds);
    const appendedCount = targets.filter((target) => target.kind !== 'result').length;
    if (batch.jobs.length + appendedCount > MAX_BATCH_IMAGES) throw new Error(`A batch may contain at most ${MAX_BATCH_IMAGES} images.`);
    const now = new Date().toISOString();
    const scheduled: BatchJob[] = [];
    for (const [offset, target] of targets.entries()) {
      const job = target.job;
      if (job.status === 'queued' || job.status === 'running') throw new Error(`${job.name} is still in progress.`);
      if (target.kind !== 'result') {
        const appended = makeJob({
          index: batch.jobs.length,
          prompt,
          referenceImageIds: unique([target.imageId, ...additionalReferenceImageIds]),
          requestKey: derivedRequestKey(input.requestKey, `modify:${offset}:${target.imageId}`),
          operation: operationFor(offering, 'modify'),
          offering,
          size: input.size,
          quality: input.quality,
          now,
        });
        batch.jobs.push(appended);
        scheduled.push(appended);
        continue;
      }
      if (job.outputImageId && !job.backups.some((backup) => backup.imageId === job.outputImageId)) {
        job.backups.push({
          id: randomUUID(),
          name: `${job.name}-${job.backups.length + 1}`,
          imageId: job.outputImageId,
          prompt: job.prompt,
          referenceImageIds: [...job.referenceImageIds],
          offering: structuredClone(job.offering || batch.offering),
          createdAt: now,
        });
      }
      job.prompt = prompt;
      job.operation = operationFor(offering, 'modify');
      job.offering = offering;
      job.referenceImageIds = unique([target.imageId, ...additionalReferenceImageIds]);
      job.outputImageId = undefined;
      job.requestKey = derivedRequestKey(input.requestKey, `modify:${offset}:${target.imageId}`);
      job.status = 'queued';
      job.progress = 0;
      job.retryable = false;
      job.chargeState = 'not_charged';
      job.error = undefined;
      job.requestId = undefined;
      job.startedAt = undefined;
      job.finishedAt = undefined;
      job.durationMs = undefined;
      job.generationOptions = { size: input.size, quality: input.quality };
      scheduled.push(job);
    }
    const ids = scheduled.map((job) => job.id);
    batch.modificationKeys[input.requestKey] = ids;
    batch.updatedAt = now;
    await this.options.store.save(batch);
    this.activeBatchId = batch.id;
    await this.changed();
    this.schedule();
    return { batch: snapshot(batch), modifiedJobIds: ids };
  }

  async cancelQueued(batchId: string): Promise<BatchSnapshot> {
    const batch = this.requiredBatch(batchId);
    const now = new Date().toISOString();
    for (const job of batch.jobs) {
      if (job.status !== 'queued') continue;
      job.status = 'canceled';
      job.progress = 100;
      job.finishedAt = now;
      job.chargeState = 'not_charged';
    }
    batch.updatedAt = now;
    await this.options.store.save(batch);
    await this.changed();
    return snapshot(batch);
  }

  async retry(batchId: string, jobIds: string[], allowUnknownCharge = false): Promise<BatchSnapshot> {
    const batch = this.requiredBatch(batchId);
    const requested = new Set(jobIds);
    const matches = batch.jobs.filter((job) => requested.has(job.id));
    if (matches.length !== requested.size) throw new Error('One or more jobs do not belong to this batch.');
    const now = new Date().toISOString();
    for (const job of matches) {
      if (job.status !== 'failed') throw new Error(`${job.name} is not a failed job.`);
      if (!job.retryable) throw new Error(`${job.name} is not retryable.`);
      if (job.chargeState === 'unknown' && !allowUnknownCharge) throw new Error(`${job.name} cannot be retried without an explicit unknown-charge confirmation.`);
      job.status = 'queued';
      job.progress = 0;
      job.retryable = false;
      job.error = undefined;
      job.requestId = undefined;
      job.startedAt = undefined;
      job.finishedAt = undefined;
      job.durationMs = undefined;
      job.chargeState = 'not_charged';
      job.requestKey = derivedRequestKey(job.requestKey, `manual-retry:${job.attempt + 1}`);
    }
    batch.updatedAt = now;
    await this.options.store.save(batch);
    await this.changed();
    this.schedule();
    return snapshot(batch);
  }

  async deleteImages(batchId: string, imageIds: string[]): Promise<BatchSnapshot> {
    const batch = this.requiredBatch(batchId);
    const ids = unique(imageIds);
    if (!ids.length) throw new Error('Select at least one image to delete.');
    const targets = ids.map((id) => this.resolveBatchImage(batch, id));
    for (const { job } of targets) {
      if (job.status === 'queued' || job.status === 'running') throw new Error(`${job.name} is still in progress.`);
    }
    await this.options.imageStore.trash(ids);
    for (const target of targets) {
      const job = target.job;
      if (target.kind === 'result') {
        const related = job.backups.map((backup) => backup.imageId);
        if (related.length) await this.options.imageStore.trash(related);
        job.outputImageId = undefined;
        job.backups = [];
        job.status = 'canceled';
      } else if (target.kind === 'backup') {
        job.backups = job.backups.filter((backup) => backup.imageId !== target.imageId);
        job.referenceImageIds = job.referenceImageIds.filter((id) => id !== target.imageId);
      } else {
        job.referenceImageIds = job.referenceImageIds.filter((id) => id !== target.imageId);
        job.status = 'canceled';
      }
    }
    batch.updatedAt = new Date().toISOString();
    await this.options.store.save(batch);
    await this.changed();
    return snapshot(batch);
  }

  async deleteBatch(batchId: string): Promise<void> {
    const batch = this.requiredBatch(batchId);
    if (batch.jobs.some((job) => job.status === 'queued' || job.status === 'running')) throw new Error('Cancel or finish active jobs before deleting the batch.');
    this.batches.delete(batchId);
    if (batch.requestKey) this.createKeys.delete(batch.requestKey);
    await this.options.store.delete(batchId);
    this.activeBatchId = this.list()[0]?.id;
    await this.changed();
  }

  async merge(input: {
    targetBatchId: string;
    sourceBatchIds: string[];
    deleteSourceBatches?: boolean;
    requestKey: string;
  }): Promise<BatchSnapshot> {
    assertRequestKey(input.requestKey);
    const target = this.requiredBatch(input.targetBatchId);
    const replay = target.mergeKeys[input.requestKey];
    if (replay) return snapshot(target);
    const sources = unique(input.sourceBatchIds).map((id) => this.requiredBatch(id));
    if (sources.some((batch) => batch.id === target.id)) throw new Error('The target batch cannot also be a source batch.');
    if (![target, ...sources].every(isTerminal)) throw new Error('Only terminal batches can be merged.');
    const incoming = sources.flatMap((batch) => batch.jobs);
    if (target.jobs.length + incoming.length > MAX_BATCH_IMAGES) throw new Error(`A merged batch may contain at most ${MAX_BATCH_IMAGES} images.`);
    const now = new Date().toISOString();
    const clonedIds: string[] = [];
    for (const sourceJob of incoming) {
      const id = randomUUID();
      clonedIds.push(id);
      target.jobs.push({
        ...structuredClone(sourceJob),
        id,
        index: target.jobs.length,
        name: `图${target.jobs.length + 1}`,
      });
    }
    target.mergeKeys[input.requestKey] = clonedIds;
    target.updatedAt = now;
    await this.options.store.save(target);
    if (input.deleteSourceBatches) {
      for (const source of sources) {
        this.batches.delete(source.id);
        if (source.requestKey) this.createKeys.delete(source.requestKey);
        await this.options.store.delete(source.id);
      }
    }
    this.activeBatchId = target.id;
    await this.changed();
    return snapshot(target);
  }

  async startAgentJob(batchId: string, jobId: string): Promise<BatchJob> {
    const { batch, job } = this.requiredJob(batchId, jobId);
    if (job.operation !== 'agent') throw new Error('This job is owned by the Esse managed provider, not the current Agent.');
    if (job.status === 'running' || job.status === 'succeeded') return structuredClone(job);
    if (job.status !== 'queued') throw new Error(`${job.name} is not queued.`);
    beginJob(job, job.offering || batch.offering, 'agent');
    batch.updatedAt = new Date().toISOString();
    await this.options.store.save(batch);
    await this.changed();
    return structuredClone(job);
  }

  completeAgentJob(batchId: string, jobId: string, outputPath: string): Promise<BatchSnapshot> {
    const key = `${batchId}:${jobId}`;
    const existing = this.agentCompletionChains.get(key);
    if (existing) return existing;
    const completion = this.completeAgentJobOnce(batchId, jobId, outputPath).finally(() => this.agentCompletionChains.delete(key));
    this.agentCompletionChains.set(key, completion);
    return completion;
  }

  private async completeAgentJobOnce(batchId: string, jobId: string, outputPath: string): Promise<BatchSnapshot> {
    const { batch, job } = this.requiredJob(batchId, jobId);
    if (job.operation !== 'agent') throw new Error('This job is owned by the Esse managed provider, not the current Agent.');
    if (job.status === 'succeeded') return snapshot(batch);
    if (job.status === 'queued') beginJob(job, job.offering || batch.offering, 'agent');
    if (job.status !== 'running') throw new Error('Agent job is not running.');
    batch.updatedAt = new Date().toISOString();
    await this.options.store.save(batch);
    await this.changed();
    try {
      const saved = await this.options.imageStore.importFile({
        sourcePath: outputPath,
        requestId: `agent-${createHash('sha256').update(job.requestKey).digest('hex')}`,
        prompt: job.prompt,
        model: (job.offering || batch.offering).id,
      });
      finishSucceeded(job, { requestId: job.requestKey, items: [], reused: false }, saved.id);
    } catch (error) {
      finishFailed(job, error, 'unknown', false);
      throw error;
    } finally {
      batch.updatedAt = new Date().toISOString();
      await this.options.store.save(batch);
      await this.changed();
    }
    return snapshot(batch);
  }

  async failAgentJob(batchId: string, jobId: string, reason: string): Promise<BatchSnapshot> {
    const { batch, job } = this.requiredJob(batchId, jobId);
    if (job.operation === 'agent' && job.status === 'failed') return snapshot(batch);
    if (job.operation !== 'agent' || !['queued', 'running'].includes(job.status)) throw new Error('Agent job is not pending.');
    if (job.status === 'queued') beginJob(job, job.offering || batch.offering, 'agent');
    finishFailed(job, new Error(requiredPrompt(reason)), 'unknown', false);
    batch.updatedAt = new Date().toISOString();
    await this.options.store.save(batch);
    await this.changed();
    return snapshot(batch);
  }

  async inspectFolder(directory: string, recursive = false, maxImages = 500): Promise<Array<{ path: string; name: string; sizeBytes: number; modifiedAt: string }>> {
    const resolved = path.resolve(directory);
    const root = await stat(resolved);
    if (!root.isDirectory()) throw new Error('The image folder path is not a directory.');
    const files: string[] = [];
    const pending = [resolved];
    while (pending.length && files.length < maxImages) {
      const current = pending.shift()!;
      const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory() && recursive) pending.push(fullPath);
        else if (entry.isFile() && /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(entry.name)) files.push(fullPath);
        if (files.length >= maxImages) break;
      }
    }
    return Promise.all(files.map(async (fullPath) => {
      const details = await stat(fullPath);
      return { path: fullPath, name: path.basename(fullPath), sizeBytes: details.size, modifiedAt: details.mtime.toISOString() };
    }));
  }

  private async run(jobKey: string, batchId: string, jobId: string): Promise<void> {
    const batch = this.batches.get(batchId);
    const job = batch?.jobs.find((candidate) => candidate.id === jobId);
    if (!batch || !job || job.status !== 'queued') {
      this.activeJobs.delete(jobKey);
      return;
    }
    const offering = job.offering || batch.offering;
    beginJob(job, offering, 'provider');
    batch.updatedAt = new Date().toISOString();
    await this.options.store.save(batch);
    await this.changed();
    let providerSubmitted = false;
    try {
      const client = await this.options.createApiClient();
      const input = {
        prompt: job.prompt,
        model: offering.id,
        size: job.generationOptions?.size,
        quality: job.generationOptions?.quality,
        n: 1,
      };
      let result: ApiGenerateResult;
      if (job.referenceImageIds.length) {
        const sourcePaths = await Promise.all(job.referenceImageIds.map((id) => this.options.imageStore.pathForId(id)));
        providerSubmitted = true;
        result = await client.edit(input, sourcePaths, job.requestKey);
      } else {
        providerSubmitted = true;
        result = await client.generate(input, job.requestKey);
      }
      const [saved] = await this.options.imageStore.saveBatch({
        requestId: result.requestId,
        prompt: job.prompt,
        model: offering.id,
        items: result.items,
        trustedBaseUrl: result.trustedBaseUrl,
      });
      if (!saved) throw new Error('Provider returned no image that Esse could save.');
      finishSucceeded(job, result, saved.id);
    } catch (error) {
      const chargeState = error instanceof EsseApiError ? error.details.chargeState : providerSubmitted ? 'unknown' : 'not_charged';
      const retryable = error instanceof EsseApiError && (error.details.chargeState === 'unknown'
        || (error.details.chargeState === 'not_charged'
          && (error.details.status === 429 || (error.details.status !== undefined && error.details.status >= 500))));
      finishFailed(job, error, chargeState, retryable);
      if (retryable && chargeState === 'not_charged' && job.attempt <= AUTO_RETRY_LIMIT) {
        const failedMessage = job.error;
        job.status = 'queued';
        job.progress = 0;
        job.retryable = false;
        job.chargeState = 'not_charged';
        job.error = `自动重试 ${job.attempt}/${AUTO_RETRY_LIMIT}：${failedMessage}`;
        job.requestId = undefined;
        job.startedAt = undefined;
        job.finishedAt = undefined;
        job.durationMs = undefined;
        job.requestKey = derivedRequestKey(job.requestKey, `auto-retry:${job.attempt + 1}`);
      }
    } finally {
      batch.updatedAt = new Date().toISOString();
      await this.options.store.save(batch);
      this.activeJobs.delete(jobKey);
      await this.changed();
      this.schedule();
    }
  }

  private schedule(): void {
    if (!this.initialized || this.scheduling) return;
    this.scheduling = true;
    queueMicrotask(async () => {
      this.scheduling = false;
      if (this.options.canRun && !await this.options.canRun()) return;
      const globalLimit = Math.max(1, Math.min(12, this.options.concurrency ?? 12));
      for (const batch of this.listRecords()) {
        for (const job of batch.jobs) {
          if (this.activeJobs.size >= globalLimit) return;
          if (job.status !== 'queued' || job.operation === 'agent') continue;
          const key = `${batch.id}:${job.id}`;
          if (this.activeJobs.has(key)) continue;
          const offering = job.offering || batch.offering;
          if (this.activeProviderJobs(offering) >= Math.max(1, Math.min(12, offering.concurrency || DEFAULT_CONCURRENCY))) continue;
          this.activeJobs.add(key);
          void this.run(key, batch.id, job.id);
        }
      }
    });
  }

  private async resolveOffering(id?: string): Promise<OfferingSummary> {
    const offerings = await this.offerings();
    const requested = id || await this.options.getDefaultOfferingId?.();
    if (requested) {
      const exact = offerings.find((offering) => offering.id === requested);
      if (!exact) throw new Error(`Model ${requested} is not available.`);
      if (!exact.configured) throw new Error(`${exact.providerName} · ${exact.tierName} 还没有 API Key，请先在 Esse 设置中完成配置。`);
      return exact;
    }
    const managedOfferings = offerings.filter((offering) => offering.providerType !== 'agent-generation' && offering.configured);
    if (managedOfferings.length === 1) return managedOfferings[0];
    if (offerings.length === 1) return offerings[0];
    if (!managedOfferings.length) throw new Error('No managed image model is currently available. Select workbuddy-agent-generation explicitly to use the current WorkBuddy Agent.');
    throw new Error(`More than one model is available. Choose one of: ${offerings.map((offering) => offering.id).join(', ')}.`);
  }

  private resolveBatchImage(batch: BatchRecord, imageId: string): ResolvedBatchImage {
    for (const job of batch.jobs) {
      if (job.outputImageId === imageId) return { kind: 'result', job, imageId };
      if (job.backups.some((backup) => backup.imageId === imageId)) return { kind: 'backup', job, imageId };
      if (job.status === 'failed' && !job.outputImageId && job.referenceImageIds.includes(imageId)) return { kind: 'failed-source', job, imageId };
    }
    throw new Error(`Image ${imageId} does not belong to batch ${batch.id}.`);
  }

  private async assertImagesExist(ids: string[]): Promise<void> {
    for (const id of unique(ids)) {
      if (!await this.options.imageStore.get(id)) throw new Error(`Reference image ${id} was not found.`);
    }
  }

  private requiredBatch(id: string): BatchRecord {
    const batch = this.batches.get(id);
    if (!batch) throw new Error(`Batch ${id} was not found.`);
    return batch;
  }

  private requiredJob(batchId: string, jobId: string): { batch: BatchRecord; job: BatchJob } {
    const batch = this.requiredBatch(batchId);
    const job = batch.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Job ${jobId} was not found in batch ${batchId}.`);
    return { batch, job };
  }

  private listRecords(): BatchRecord[] {
    return [...this.batches.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private activeProviderJobs(offering: OfferingSummary): number {
    let count = 0;
    for (const key of this.activeJobs) {
      const separator = key.indexOf(':');
      const batch = this.batches.get(key.slice(0, separator));
      const job = batch?.jobs.find((candidate) => candidate.id === key.slice(separator + 1));
      const activeOffering = job?.offering || batch?.offering;
      if (activeOffering && activeOffering.providerName === offering.providerName && activeOffering.tierName === offering.tierName && activeOffering.providerType === offering.providerType) count += 1;
    }
    return count;
  }

  private async importLegacyImages(): Promise<void> {
    const referenced = new Set(this.listRecords().flatMap((batch) => batch.jobs.flatMap((job) => [job.outputImageId, ...job.backups.map((backup) => backup.imageId)]).filter(Boolean)) as string[]);
    const legacy = (await this.options.imageStore.list()).filter((image) => !referenced.has(image.id));
    const groups = new Map<string, SavedImage[]>();
    for (const image of legacy) groups.set(image.requestId, [...(groups.get(image.requestId) ?? []), image]);
    for (const images of groups.values()) {
      const first = images[0];
      if (!first) continue;
      const now = first.createdAt;
      const batch: BatchRecord = {
        id: randomUUID(),
        appendKeys: {},
        modificationKeys: {},
        mergeKeys: {},
        title: cleanTitle(first.prompt),
        prompt: first.prompt,
        offering: {
          id: first.model,
          canonicalModelId: first.model,
          providerModelId: first.model,
          displayName: first.model,
          providerName: '旧版模型',
          providerType: 'legacy',
          tierName: '导入记录',
          concurrency: DEFAULT_CONCURRENCY,
          priceMicros: 0,
          currency: 'CNY',
          price: { mode: 'unknown', currency: 'CNY' },
          configured: false,
          sizes: [],
          supportsTextToImage: true,
          supportsImageToImage: true,
        },
        jobs: images.map((image, index) => ({
          ...makeJob({ index, prompt: image.prompt, referenceImageIds: [], requestKey: derivedRequestKey(image.requestId, `legacy:${index}`), operation: 'generate', now }),
          status: 'succeeded',
          progress: 100,
          chargeState: 'charged',
          outputImageId: image.id,
          requestId: image.requestId,
          finishedAt: now,
        })),
        createdAt: now,
        updatedAt: now,
      };
      this.batches.set(batch.id, batch);
      await this.options.store.save(batch);
    }
  }

  private async changed(): Promise<void> {
    await this.options.onChanged?.();
  }
}

function makeJob(input: {
  index: number;
  prompt: string;
  referenceImageIds: string[];
  requestKey: string;
  operation: BatchJob['operation'];
  offering?: OfferingSummary;
  size?: string;
  quality?: string;
  now: string;
}): BatchJob {
  return {
    id: randomUUID(),
    index: input.index,
    name: `图${input.index + 1}`,
    prompt: requiredPrompt(input.prompt),
    requestKey: input.requestKey,
    operation: input.operation,
    status: 'queued',
    progress: 0,
    attempt: 0,
    retryable: false,
    chargeState: 'not_charged',
    referenceImageIds: unique(input.referenceImageIds),
    backups: [],
    createdAt: input.now,
    callHistory: [],
    generationOptions: { size: input.size, quality: input.quality },
    offering: input.offering,
  };
}

function beginJob(job: BatchJob, offering: OfferingSummary, source: 'provider' | 'agent'): void {
  const now = new Date().toISOString();
  job.status = 'running';
  job.progress = 20;
  job.attempt += 1;
  job.retryable = false;
  job.chargeState = 'unknown';
  job.startedAt = now;
  job.finishedAt = undefined;
  job.error = undefined;
  job.callHistory.push({
    id: randomUUID(),
    sequence: job.callHistory.length + 1,
    attempt: job.attempt,
    source,
    offering: structuredClone(offering),
    status: 'running',
    chargeState: 'unknown',
    startedAt: now,
  });
}

function finishSucceeded(job: BatchJob, result: ApiGenerateResult, imageId: string): void {
  const now = new Date().toISOString();
  const started = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
  job.status = 'succeeded';
  job.progress = 100;
  job.retryable = false;
  job.chargeState = 'charged';
  job.outputImageId = imageId;
  job.requestId = result.requestId;
  job.finishedAt = now;
  job.durationMs = Math.max(0, Date.now() - started);
  const call = job.callHistory.at(-1);
  if (call) Object.assign(call, { status: 'succeeded', chargeState: 'charged', requestId: result.requestId, finishedAt: now, durationMs: job.durationMs });
}

function finishFailed(job: BatchJob, error: unknown, chargeState: 'not_charged' | 'unknown', retryable: boolean): void {
  const now = new Date().toISOString();
  const started = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
  const message = error instanceof Error ? error.message : 'Image request failed.';
  job.status = 'failed';
  job.progress = 100;
  job.retryable = retryable;
  job.chargeState = chargeState;
  job.error = message;
  job.finishedAt = now;
  job.durationMs = Math.max(0, Date.now() - started);
  if (error instanceof EsseApiError) job.requestId = error.details.requestId;
  const call = job.callHistory.at(-1);
  if (call) Object.assign(call, { status: 'failed', chargeState, requestId: job.requestId, error: message, finishedAt: now, durationMs: job.durationMs });
}

function snapshot(batch: BatchRecord): BatchSnapshot {
  const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
  for (const job of batch.jobs) counts[job.status] += 1;
  let status: BatchSnapshot['status'];
  if (counts.running) status = 'running';
  else if (counts.queued) status = 'queued';
  else if (counts.failed && counts.succeeded) status = 'partial';
  else if (counts.failed) status = 'failed';
  else if (counts.canceled === batch.jobs.length) status = 'canceled';
  else status = 'completed';
  return {
    ...structuredClone(batch),
    status,
    total: batch.jobs.length,
    ...counts,
    estimatedCostMicros: batch.jobs.reduce((total, job) => total + (job.offering || batch.offering).priceMicros, 0),
  };
}

function normalizedJobs(input: CreateBatchInput): Array<{ prompt: string; referenceImageIds: string[] }> {
  if (input.jobs?.length) return input.jobs.map((job) => {
    const referenceImageIds = unique(job.referenceImageIds ?? []);
    assertReferenceCount(referenceImageIds);
    return { prompt: requiredPrompt(job.prompt), referenceImageIds };
  });
  const prompt = requiredPrompt(input.prompt || '');
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_IMAGES) throw new Error('Image count must be between 1 and 50.');
  return Array.from({ length: count }, () => ({ prompt, referenceImageIds: [] }));
}

function normalizeBatch(batch: BatchRecord): BatchRecord {
  batch.appendKeys ??= {};
  batch.modificationKeys ??= {};
  batch.mergeKeys ??= {};
  batch.offering = normalizeOffering(batch.offering);
  for (const [index, job] of batch.jobs.entries()) {
    job.index = index;
    job.name = `图${index + 1}`;
    job.requestKey ||= derivedRequestKey(batch.requestKey || batch.id, `job:${job.id}`);
    job.operation ??= 'generate';
    job.referenceImageIds ??= [];
    job.backups ??= [];
    job.callHistory ??= [];
    if (job.offering) job.offering = normalizeOffering(job.offering);
    for (const backup of job.backups) {
      if (backup.offering) backup.offering = normalizeOffering(backup.offering);
    }
    for (const call of job.callHistory) {
      if (call.offering) call.offering = normalizeOffering(call.offering);
    }
  }
  return batch;
}

function normalizeOffering(offering: OfferingSummary): OfferingSummary {
  const priceMicros = Number.isFinite(offering.priceMicros) ? offering.priceMicros : 0;
  const currency = offering.currency || 'CNY';
  return {
    ...offering,
    tierName: offering.tierName || '旧版配置',
    concurrency: Number.isInteger(offering.concurrency) && offering.concurrency > 0 ? offering.concurrency : 3,
    priceMicros,
    currency,
    price: offering.price ?? (offering.providerType === 'agent-generation'
      ? { mode: 'model_quota', currency: 'MODEL' }
      : { mode: 'per_request', currency, amount: priceMicros / 1_000_000 }),
    configured: offering.configured ?? true,
  };
}

function assertLegacyEstimate(offering: OfferingSummary, count: number, approved?: number): void {
  if (approved === undefined) return;
  const estimate = offering.priceMicros * count;
  if (approved !== estimate) throw new Error('The supplied legacy price estimate is stale. Retry without approvedEstimatedCostMicros so Esse can use the configured Provider price.');
}

function assertRequestKey(value: string): void {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new Error('requestKey must contain 8 to 200 letters, numbers, dots, underscores, colons, or hyphens.');
}

function derivedRequestKey(root: string, suffix: string): string {
  return `esse:${createHash('sha256').update(`${root}:${suffix}`).digest('hex')}`;
}

function requiredPrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt || prompt.length > 20_000) throw new Error('Prompt must contain between 1 and 20,000 characters.');
  return prompt;
}

function cleanTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80) || '新图片批次';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function assertReferenceCount(values: string[]): void {
  if (unique(values).length > MAX_REFERENCE_IMAGES) throw new Error(`Each image job may use at most ${MAX_REFERENCE_IMAGES} reference images.`);
}

function operationFor(offering: OfferingSummary, managedOperation: 'generate' | 'modify'): BatchJob['operation'] {
  return offering.providerType === 'agent-generation' ? 'agent' : managedOperation;
}

function isTerminal(batch: BatchRecord): boolean {
  return batch.jobs.every((job) => !['queued', 'running'].includes(job.status));
}
