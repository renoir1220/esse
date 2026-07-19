import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import type { DataPaths } from "../paths.js";
import { imageFileToDataUrl } from "../files/image-files.js";
import { backupImageVersion, importGeneratedImage, saveGeneratedImage } from "../files/output-files.js";
import type { BatchActivation, BatchRecord, BatchSnapshot, BatchStatus, JobBackup, JobCallRecord, JobCallStatus, JobRecord, OfferingSnapshot, ProviderRequestError } from "../types.js";
import { ProviderRequestError as ProviderError } from "../types.js";
import type { BatchStore } from "../storage/batch-store.js";
import type { ProviderRegistry, ResolvedOffering } from "../providers/registry.js";
import { Semaphore } from "./semaphore.js";

export interface CreateBatchInput {
  title?: string;
  offeringId: string;
  prompt: string;
  imagePaths?: string[];
  referenceImagePaths?: string[];
  jobs?: Array<{ prompt: string; referenceImagePaths?: string[] }>;
  inputDirectory?: string;
  outputDirectory?: string;
  count?: number;
  perImagePrompts?: Record<string, string>;
  size?: string;
  quality?: string;
  requestKey?: string;
}

interface RuntimeJobOptions { size?: string; quality?: string }
type SelectedBatchImage =
  | { kind: "result" | "failed-source"; job: JobRecord; sourcePath: string }
  | { kind: "backup"; job: JobRecord; backup: JobBackup; sourcePath: string };
type ImageForDeletion =
  | { kind: "job"; job: JobRecord }
  | { kind: "backup"; job: JobRecord; backup: JobBackup };
const AUTO_RETRY_LIMIT = 3;
const MAX_BATCH_IMAGES = 50;

export class BatchManager {
  private readonly batches = new Map<string, BatchRecord>();
  private readonly requestKeys = new Map<string, string>();
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly runtimeOptions = new Map<string, RuntimeJobOptions>();
  private readonly saveChains = new Map<string, Promise<void>>();
  private readonly agentCompletionChains = new Map<string, Promise<BatchSnapshot>>();
  private activationRevision = Date.now();
  private activatedBatchId: string | undefined;

  constructor(
    private readonly store: BatchStore,
    private readonly registry: ProviderRegistry,
    private readonly paths: DataPaths
  ) {}

  async initialize(): Promise<void> {
    for (const batch of await this.store.loadAll()) {
      let changed = false;
      for (const job of batch.jobs) {
        if (migrateLegacyCallHistory(job, job.offering || batch.offering)) changed = true;
        const chineseName = `图${job.index + 1}`;
        if (!/^图\d+$/u.test(job.name)) {
          job.name = chineseName;
          changed = true;
        }
        if (job.status === "running") {
          const agentGenerated = (job.offering || batch.offering).adapterId === "agent-generation";
          const finished = Date.now();
          const started = job.startedAt ? new Date(job.startedAt).getTime() : finished;
          const interruptionError = agentGenerated
            ? "当前 Agent 在返回图片前中断了。请重新向 Agent 发起这项生成任务。"
            : "The local plugin stopped while this provider request was running. Review billing before retrying.";
          Object.assign(job, {
            status: "failed",
            progress: 100,
            retryable: !agentGenerated,
            chargeState: "unknown",
            error: interruptionError,
            finishedAt: new Date(finished).toISOString(),
            durationMs: Math.max(0, finished - started)
          });
          finishActiveCall(job, "failed", {
            finishedAt: new Date(finished).toISOString(),
            durationMs: Math.max(0, finished - started),
            chargeState: "unknown",
            error: interruptionError
          });
          changed = true;
        } else if (job.status === "queued") {
          const agentGenerated = (job.offering || batch.offering).adapterId === "agent-generation";
          Object.assign(job, {
            status: "canceled",
            progress: 0,
            chargeState: "not_charged",
            error: agentGenerated
              ? "本地插件重启前，当前 Agent 尚未开始这项生成任务。"
              : "Canceled because the local plugin restarted before this job began.",
            finishedAt: new Date().toISOString()
          });
          changed = true;
        }
      }
      if (changed) {
        batch.updatedAt = new Date().toISOString();
        await this.store.save(batch);
      }
      this.batches.set(batch.id, batch);
      if (batch.requestKey) this.requestKeys.set(batch.requestKey, batch.id);
    }
  }

  async create(input: CreateBatchInput): Promise<BatchSnapshot> {
    const existingId = input.requestKey ? this.requestKeys.get(input.requestKey) : undefined;
    if (existingId) {
      this.activate(existingId);
      return this.get(existingId);
    }
    const resolved = await this.registry.resolveOffering(input.offeringId);
    if (!isAgentGeneration(resolved) && !resolved.profile.hasApiKey) throw new Error(`Provider ${resolved.profile.displayName} · ${resolved.profile.tierName} has no API key.`);
    const imagePaths = (input.imagePaths || []).map((value) => path.resolve(value));
    const referenceImagePaths = [...new Set((input.referenceImagePaths || []).map((value) => path.resolve(value)))];
    const jobInputs = input.jobs || [];
    const count = jobInputs.length || imagePaths.length || Math.max(1, Math.trunc(input.count || 1));
    if (count > MAX_BATCH_IMAGES) throw new Error(`A batch can contain at most ${MAX_BATCH_IMAGES} jobs.`);
    const hasReferenceImages = Boolean(imagePaths.length || referenceImagePaths.length || jobInputs.some((job) => job.referenceImagePaths?.length));
    if (hasReferenceImages && !resolved.offering.supportsImageToImage) throw new Error(`${resolved.offering.displayName} does not support image editing.`);
    if (!hasReferenceImages && !resolved.offering.supportsTextToImage) throw new Error(`${resolved.offering.displayName} does not support text-to-image generation.`);

    const id = randomUUID();
    const now = new Date().toISOString();
    const outputDirectory = path.resolve(input.outputDirectory || defaultOutputDirectory(this.paths, input.inputDirectory, id));
    await mkdir(outputDirectory, { recursive: true });
    const jobs: JobRecord[] = Array.from({ length: count }, (_, index) => {
      const inputPath = imagePaths[index];
      const sourceName = inputPath ? path.basename(inputPath) : `generation-${index + 1}.png`;
      const name = `图${index + 1}`;
      const jobReferencePaths = (jobInputs[index]?.referenceImagePaths || []).map((value) => path.resolve(value));
      const inputPaths = [...new Set([...(inputPath ? [inputPath] : []), ...referenceImagePaths, ...jobReferencePaths])];
      return {
        id: randomUUID(),
        index,
        name,
        inputPath: inputPaths[0],
        inputPaths: inputPaths.length ? inputPaths : undefined,
        referenceImagePaths: inputPaths.length ? inputPaths : undefined,
        offering: resolved.snapshot,
        prompt: jobInputs[index]?.prompt.trim() || promptFor(input, inputPath, sourceName, index),
        status: "queued",
        progress: 0,
        attempt: 1,
        retryable: false,
        chargeState: "not_charged",
        createdAt: now
      };
    });
    const batch: BatchRecord = {
      id,
      requestKey: input.requestKey,
      title: input.title?.trim() || `${resolved.offering.displayName} · ${count} 张`,
      prompt: input.prompt,
      inputDirectory: input.inputDirectory ? path.resolve(input.inputDirectory) : undefined,
      outputDirectory,
      offering: resolved.snapshot,
      jobs,
      createdAt: now,
      updatedAt: now
    };
    this.batches.set(id, batch);
    if (input.requestKey) this.requestKeys.set(input.requestKey, id);
    this.runtimeOptions.set(id, { size: input.size, quality: input.quality });
    await this.store.save(batch);
    this.activate(id);
    if (!isAgentGeneration(resolved)) for (const job of jobs) this.schedule(batch, job, resolved);
    return snapshot(batch);
  }

  async modifyInPlace(options: {
    batchId: string;
    imageIds?: string[];
    jobIds?: string[];
    instructions: string;
    offeringId?: string;
    outputDirectory?: string;
    requestKey?: string;
  }): Promise<BatchSnapshot> {
    const source = this.requireBatch(options.batchId);
    if (options.requestKey && source.modificationKeys?.[options.requestKey]) {
      this.activate(source.id);
      return snapshot(source);
    }
    const selectors = [...new Set((options.imageIds || options.jobIds || []).map((value) => value.trim()).filter(Boolean))];
    if (!selectors.length) throw new Error("Select at least one image to modify.");
    const selected = selectors.map((selector) => resolveBatchImage(source, selector));
    const appendedCount = selected.filter((image) => image.kind !== "result").length;
    if (source.jobs.length + appendedCount > MAX_BATCH_IMAGES) {
      throw new Error(`The modified batch would exceed the ${MAX_BATCH_IMAGES}-image limit.`);
    }
    const resolved = await this.registry.resolveOffering(options.offeringId || source.offering.id);
    if (!isAgentGeneration(resolved) && !resolved.profile.hasApiKey) throw new Error(`Provider ${resolved.profile.displayName} · ${resolved.profile.tierName} has no API key.`);
    if (!resolved.offering.supportsImageToImage) throw new Error(`${resolved.offering.displayName} does not support image editing.`);
    const now = new Date().toISOString();
    const scheduled: JobRecord[] = [];
    for (const image of selected) {
      if (image.kind === "result") {
        const job = image.job;
        const version = nextBackupVersion(job);
        const backupName = `${job.name}-${version}`;
        const backupPath = await backupImageVersion({ sourcePath: image.sourcePath, outputDirectory: source.outputDirectory, displayName: backupName });
        job.backups = [...(job.backups || []), {
          id: randomUUID(),
          name: backupName,
          outputPath: backupPath,
          prompt: job.prompt,
          referenceImagePaths: job.referenceImagePaths || job.inputPaths || (job.inputPath ? [job.inputPath] : undefined),
          offering: job.offering || source.offering,
          createdAt: now
        }];
        Object.assign(job, {
          generationInputPath: image.sourcePath,
          generationInputPaths: undefined,
          referenceImagePaths: [backupPath],
          offering: resolved.snapshot,
          prompt: options.instructions,
          status: "queued",
          progress: 0,
          attempt: 1,
          retryable: false,
          chargeState: "not_charged",
          error: undefined,
          providerRequestId: undefined,
          startedAt: undefined,
          finishedAt: undefined,
          durationMs: undefined
        });
        scheduled.push(job);
        continue;
      }
      const slot = nextJobSlot(source);
      const job: JobRecord = {
        id: randomUUID(),
        index: slot.index,
        name: slot.name,
        inputPath: image.sourcePath,
        inputPaths: [image.sourcePath],
        referenceImagePaths: [image.sourcePath],
        offering: resolved.snapshot,
        prompt: options.instructions,
        status: "queued",
        progress: 0,
        attempt: 1,
        retryable: false,
        chargeState: "not_charged",
        createdAt: now
      };
      source.jobs.push(job);
      scheduled.push(job);
    }
    if (options.requestKey) {
      source.modificationKeys = { ...(source.modificationKeys || {}), [options.requestKey]: scheduled.map((job) => job.id) };
    }
    source.updatedAt = now;
    await this.persist(source);
    this.activate(source.id);
    if (!isAgentGeneration(resolved)) for (const job of scheduled) this.schedule(source, job, resolved);
    return snapshot(source);
  }

  async startAgentJob(batchId: string, jobId: string): Promise<BatchSnapshot> {
    const batch = this.requireBatch(batchId);
    const job = this.requireAgentJob(batch, jobId);
    if (job.status === "succeeded") return snapshot(batch);
    if (job.status === "failed" || job.status === "canceled") throw new Error(`${job.name} is already ${job.status}.`);
    if (job.status === "queued") {
      const startedAt = new Date().toISOString();
      Object.assign(job, {
        status: "running",
        progress: 15,
        chargeState: "unknown",
        startedAt,
        error: undefined
      });
      beginCall(job, job.offering || batch.offering, startedAt);
      batch.updatedAt = new Date().toISOString();
      await this.persist(batch);
    }
    return snapshot(batch);
  }

  completeAgentJob(batchId: string, jobId: string, imagePath: string): Promise<BatchSnapshot> {
    const key = `${batchId}:${jobId}`;
    const existing = this.agentCompletionChains.get(key);
    if (existing) return existing;
    const operation = this.completeAgentJobOnce(batchId, jobId, imagePath).finally(() => this.agentCompletionChains.delete(key));
    this.agentCompletionChains.set(key, operation);
    return operation;
  }

  async failAgentJob(batchId: string, jobId: string, error: string): Promise<BatchSnapshot> {
    const batch = this.requireBatch(batchId);
    const job = this.requireAgentJob(batch, jobId);
    if (job.status === "failed") return snapshot(batch);
    if (job.status === "succeeded" || job.status === "canceled") throw new Error(`${job.name} is already ${job.status}.`);
    const finished = Date.now();
    const started = job.startedAt ? new Date(job.startedAt).getTime() : finished;
    const call = activeCall(job) || beginCall(job, job.offering || batch.offering, new Date(started).toISOString());
    const failureMessage = error.trim() || "当前 Agent 无法生成这张图片。";
    Object.assign(job, {
      status: "failed",
      progress: 100,
      retryable: false,
      chargeState: "unknown",
      error: failureMessage,
      finishedAt: new Date(finished).toISOString(),
      durationMs: Math.max(0, finished - started)
    });
    finishCall(call, "failed", {
      finishedAt: new Date(finished).toISOString(),
      durationMs: Math.max(0, finished - started),
      chargeState: "unknown",
      error: failureMessage
    });
    batch.updatedAt = new Date().toISOString();
    await this.persist(batch);
    return snapshot(batch);
  }

  list(limit = 20): BatchSnapshot[] {
    return [...this.batches.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(MAX_BATCH_IMAGES, limit)))
      .map(snapshot);
  }

  listRecent(limit = 20): BatchSnapshot[] {
    return this.sortedByRecentActivity()
      .slice(0, Math.max(1, Math.min(MAX_BATCH_IMAGES, limit)))
      .map(snapshot);
  }

  listPage(page = 1, pageSize = 8): { batches: BatchSnapshot[]; page: number; pageSize: number; total: number; totalPages: number } {
    const safePageSize = Math.max(1, Math.min(20, Math.trunc(pageSize)));
    const total = this.batches.size;
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const safePage = Math.max(1, Math.min(totalPages, Math.trunc(page)));
    const offset = (safePage - 1) * safePageSize;
    return {
      batches: this.sortedByRecentActivity().slice(offset, offset + safePageSize).map(snapshot),
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages
    };
  }

  get(id: string): BatchSnapshot {
    return snapshot(this.requireBatch(id));
  }

  activation(): BatchActivation | undefined {
    return this.activatedBatchId ? { batchId: this.activatedBatchId, revision: this.activationRevision } : undefined;
  }

  async cancelQueued(batchId: string, jobIds?: string[]): Promise<BatchSnapshot> {
    const batch = this.requireBatch(batchId);
    for (const job of batch.jobs) {
      if (jobIds && !jobIds.includes(job.id)) continue;
      if (job.status !== "queued") continue;
      Object.assign(job, { status: "canceled", progress: 0, chargeState: "not_charged", finishedAt: new Date().toISOString() });
    }
    batch.updatedAt = new Date().toISOString();
    await this.persist(batch);
    return snapshot(batch);
  }

  async retry(batchId: string, jobIds: string[], allowUnknownCharge = false): Promise<BatchSnapshot> {
    const batch = this.requireBatch(batchId);
    for (const job of batch.jobs) {
      if (!jobIds.includes(job.id) || job.status !== "failed" || !job.retryable) continue;
      if (job.chargeState === "unknown" && !allowUnknownCharge) continue;
      Object.assign(job, {
        status: "queued",
        progress: 0,
        retryable: false,
        chargeState: "not_charged",
        error: undefined,
        providerRequestId: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        durationMs: undefined,
        attempt: job.attempt + 1
      });
      const resolved = await this.registry.resolveOffering(job.offering?.id || batch.offering.id);
      if (!isAgentGeneration(resolved)) this.schedule(batch, job, resolved);
    }
    batch.updatedAt = new Date().toISOString();
    await this.persist(batch);
    return snapshot(batch);
  }

  async deleteImages(batchId: string, imageIds: string[]): Promise<BatchSnapshot> {
    const batch = this.requireBatch(batchId);
    const selectors = [...new Set(imageIds.map((value) => value.trim()).filter(Boolean))];
    if (!selectors.length) throw new Error("Select at least one image to delete.");
    const selected = selectors.map((selector) => resolveImageForDeletion(batch, selector));
    const removedJobIds = new Set(selected.filter((entry) => entry.kind === "job").map((entry) => entry.job.id));
    const removedBackupIds = new Set(selected.flatMap((entry) => entry.kind === "backup" && !removedJobIds.has(entry.job.id) ? [entry.backup.id] : []));
    for (const entry of selected) {
      if (entry.job.status === "queued" || entry.job.status === "running") {
        throw new Error(`Cannot delete ${entry.kind === "job" ? entry.job.name : entry.backup.name} while ${entry.job.name} is active.`);
      }
    }

    const managedPaths = new Set<string>();
    for (const entry of selected) {
      const paths = entry.kind === "job" ? allJobPaths(entry.job) : [entry.backup.outputPath];
      for (const filePath of paths) if (isInside(batch.outputDirectory, filePath)) managedPaths.add(path.resolve(filePath));
    }
    const remainingJobs = batch.jobs.filter((job) => !removedJobIds.has(job.id));
    const remainingOwnedPaths = new Set<string>();
    for (const job of remainingJobs) {
      for (const filePath of explicitOwnedJobPaths(job, removedBackupIds)) {
        if (isInside(batch.outputDirectory, filePath)) remainingOwnedPaths.add(path.resolve(filePath));
      }
    }
    const pathsToDelete = new Set([...managedPaths].filter((filePath) => !remainingOwnedPaths.has(filePath)));
    for (const job of remainingJobs) {
      if ((job.status === "queued" || job.status === "running") && allJobPaths(job).some((filePath) => pathsToDelete.has(path.resolve(filePath)))) {
        throw new Error(`Cannot delete an image that active job ${job.name} still uses.`);
      }
    }
    for (const job of remainingJobs) {
      if (job.backups?.length) job.backups = job.backups.filter((backup) => !removedBackupIds.has(backup.id));
      stripJobPaths(job, pathsToDelete);
    }
    batch.jobs = remainingJobs;
    batch.updatedAt = new Date().toISOString();
    await this.persist(batch);
    for (const filePath of pathsToDelete) await rm(filePath, { force: true });
    this.activate(batch.id);
    return snapshot(batch);
  }

  async mergeBatches(options: {
    targetBatchId: string;
    sourceBatchIds: string[];
    deleteSourceBatches?: boolean;
    requestKey?: string;
  }): Promise<BatchSnapshot> {
    const target = this.requireBatch(options.targetBatchId);
    if (options.requestKey && target.mergeKeys?.[options.requestKey]) {
      this.activate(target.id);
      return snapshot(target);
    }
    const sourceIds = [...new Set(options.sourceBatchIds.map((value) => value.trim()).filter(Boolean))];
    if (!sourceIds.length) throw new Error("Select at least one source batch to merge.");
    if (sourceIds.includes(target.id)) throw new Error("The target batch cannot also be a source batch.");
    const sources = sourceIds.map((id) => this.requireBatch(id));
    if ([target, ...sources].some((batch) => batch.jobs.some((job) => job.status === "queued" || job.status === "running"))) {
      throw new Error("Only terminal batches can be merged.");
    }
    const sourceJobCount = sources.reduce((total, batch) => total + batch.jobs.length, 0);
    if (target.jobs.length + sourceJobCount > MAX_BATCH_IMAGES) {
      throw new Error(`The merged batch would exceed the ${MAX_BATCH_IMAGES}-image limit.`);
    }

    const copiedPaths: string[] = [];
    const pathCopies = new Map<string, string>();
    const copyPath = async (filePath: string | undefined, displayName: string): Promise<string | undefined> => {
      if (!filePath) return undefined;
      const resolvedPath = path.resolve(filePath);
      const managedBySource = sources.some((source) => isInside(source.outputDirectory, resolvedPath));
      if (!managedBySource) return resolvedPath;
      const existing = pathCopies.get(resolvedPath);
      if (existing) return existing;
      const copied = await backupImageVersion({ sourcePath: resolvedPath, outputDirectory: target.outputDirectory, displayName });
      pathCopies.set(resolvedPath, copied);
      copiedPaths.push(copied);
      return copied;
    };

    const clones: JobRecord[] = [];
    try {
      for (const source of sources) {
        for (const job of source.jobs) {
          const slot = nextJobSlot({ ...target, jobs: [...target.jobs, ...clones] });
          clones.push(await cloneMergedJob(job, slot, copyPath));
        }
      }
    } catch (error) {
      await Promise.all(copiedPaths.map((filePath) => rm(filePath, { force: true })));
      throw error;
    }

    const previousJobs = target.jobs;
    const previousMergeKeys = target.mergeKeys;
    target.jobs = [...target.jobs, ...clones];
    if (options.requestKey) target.mergeKeys = { ...(target.mergeKeys || {}), [options.requestKey]: clones.map((job) => job.id) };
    target.updatedAt = new Date().toISOString();
    try {
      await this.persist(target);
    } catch (error) {
      target.jobs = previousJobs;
      target.mergeKeys = previousMergeKeys;
      await Promise.all(copiedPaths.map((filePath) => rm(filePath, { force: true })));
      throw error;
    }
    if (options.deleteSourceBatches) for (const source of sources) await this.delete(source.id);
    this.activate(target.id);
    return snapshot(target);
  }

  async delete(batchId: string): Promise<void> {
    const batch = this.requireBatch(batchId);
    if (batch.jobs.some((job) => job.status === "queued" || job.status === "running")) throw new Error("正在运行的批次不能删除，请等待任务结束或先取消排队任务。");
    const managedPaths = new Set<string>();
    for (const job of batch.jobs) {
      if (job.outputPath) managedPaths.add(job.outputPath);
      if (job.generationInputPath) managedPaths.add(job.generationInputPath);
      for (const filePath of job.generationInputPaths || []) managedPaths.add(filePath);
      for (const backup of job.backups || []) managedPaths.add(backup.outputPath);
    }
    for (const filePath of managedPaths) {
      if (isInside(batch.outputDirectory, filePath)) await rm(filePath, { force: true });
    }
    const remaining = await readdir(batch.outputDirectory).catch(() => []);
    if (!remaining.length) await rmdir(batch.outputDirectory).catch(() => undefined);
    await this.store.delete(batch.id);
    this.batches.delete(batch.id);
    if (batch.requestKey) this.requestKeys.delete(batch.requestKey);
    this.runtimeOptions.delete(batch.id);
    this.saveChains.delete(batch.id);
  }

  private async completeAgentJobOnce(batchId: string, jobId: string, imagePath: string): Promise<BatchSnapshot> {
    const batch = this.requireBatch(batchId);
    const job = this.requireAgentJob(batch, jobId);
    if (job.status === "succeeded") return snapshot(batch);
    if (job.status === "failed" || job.status === "canceled") throw new Error(`${job.name} is already ${job.status}.`);
    const started = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
    const call = activeCall(job) || beginCall(job, job.offering || batch.offering, new Date(started).toISOString());
    Object.assign(job, {
      status: "running",
      progress: 90,
      chargeState: "unknown",
      startedAt: job.startedAt || new Date(started).toISOString(),
      error: undefined
    });
    batch.updatedAt = new Date().toISOString();
    await this.persist(batch);
    try {
      const previousOutputs = job.generationInputPaths?.length ? job.generationInputPaths : job.generationInputPath ? [job.generationInputPath] : [];
      job.outputPath = await importGeneratedImage({ sourcePath: imagePath, outputDirectory: batch.outputDirectory, sourceName: job.name });
      for (const previousOutput of previousOutputs) {
        if (isInside(batch.outputDirectory, previousOutput)) await rm(previousOutput, { force: true }).catch(() => undefined);
      }
      const finished = Date.now();
      Object.assign(job, {
        status: "succeeded",
        progress: 100,
        retryable: false,
        chargeState: "charged",
        generationInputPath: undefined,
        generationInputPaths: undefined,
        finishedAt: new Date(finished).toISOString(),
        durationMs: Math.max(0, finished - started)
      });
      finishCall(call, "succeeded", {
        finishedAt: new Date(finished).toISOString(),
        durationMs: Math.max(0, finished - started),
        chargeState: "charged"
      });
    } catch (error) {
      const finished = Date.now();
      const failureMessage = error instanceof Error ? error.message : "Could not import the Agent-generated image.";
      Object.assign(job, {
        status: "failed",
        progress: 100,
        retryable: false,
        chargeState: "unknown",
        error: failureMessage,
        finishedAt: new Date(finished).toISOString(),
        durationMs: Math.max(0, finished - started)
      });
      finishCall(call, "failed", {
        finishedAt: new Date(finished).toISOString(),
        durationMs: Math.max(0, finished - started),
        chargeState: "unknown",
        error: failureMessage
      });
      throw error;
    } finally {
      batch.updatedAt = new Date().toISOString();
      await this.persist(batch);
    }
    return snapshot(batch);
  }

  private schedule(batch: BatchRecord, job: JobRecord, resolved: ResolvedOffering): void {
    const semaphore = this.getSemaphore(resolved);
    void semaphore.use(async () => {
      if (job.status !== "queued") return;
      await this.runJob(batch, job, resolved);
    });
  }

  private async runJob(batch: BatchRecord, job: JobRecord, resolved: ResolvedOffering): Promise<void> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const call = beginCall(job, resolved.snapshot, startedAt);
    Object.assign(job, { status: "running", progress: 15, chargeState: "unknown", startedAt });
    batch.updatedAt = new Date().toISOString();
    await this.persist(batch);
    let autoRetry = false;
    try {
      const adapter = await this.registry.adapterFor(resolved.profile);
      const generationInputs = generationInputsFor(job);
      const images = await Promise.all(generationInputs.map((filePath) => imageFileToDataUrl(filePath)));
      const runtime = this.runtimeOptions.get(batch.id) || {};
      const result = await adapter.generate({
        model: resolved.offering.providerModelId,
        prompt: job.prompt,
        images,
        size: runtime.size,
        quality: runtime.quality,
        responseFormat: "url"
      });
      const previousOutputs = job.generationInputPaths?.length ? job.generationInputPaths : job.generationInputPath ? [job.generationInputPath] : [];
      job.outputPath = await saveGeneratedImage({ result, outputDirectory: batch.outputDirectory, sourceName: job.name });
      for (const previousOutput of previousOutputs) {
        if (isInside(batch.outputDirectory, previousOutput)) await rm(previousOutput, { force: true }).catch(() => undefined);
      }
      Object.assign(job, {
        status: "succeeded",
        progress: 100,
        retryable: false,
        chargeState: "charged",
        providerRequestId: result.providerRequestId,
        generationInputPath: undefined,
        generationInputPaths: undefined
      });
      Object.assign(call, {
        status: "succeeded",
        chargeState: "charged",
        providerRequestId: result.providerRequestId
      });
    } catch (error) {
      const providerError = error instanceof ProviderError ? error as ProviderRequestError : undefined;
      const failureMessage = error instanceof Error ? error.message : "Unknown local image generation error";
      Object.assign(job, {
        status: "failed",
        progress: 100,
        retryable: providerError?.details.retryable ?? false,
        chargeState: providerError?.details.chargeState ?? "unknown",
        error: failureMessage,
        providerRequestId: providerError?.details.requestId
      });
      Object.assign(call, {
        status: "failed",
        chargeState: providerError?.details.chargeState ?? "unknown",
        error: failureMessage,
        providerRequestId: providerError?.details.requestId
      });
      if (providerError?.details.retryable && providerError.details.chargeState === "not_charged" && job.attempt <= AUTO_RETRY_LIMIT) {
        Object.assign(job, {
          status: "queued",
          progress: 0,
          attempt: job.attempt + 1,
          retryable: false,
          chargeState: "not_charged",
          error: `自动重试 ${job.attempt}/${AUTO_RETRY_LIMIT}：${job.error}`,
          startedAt: undefined,
          finishedAt: undefined,
          durationMs: undefined
        });
        autoRetry = true;
      }
    } finally {
      const finished = Date.now();
      Object.assign(call, { finishedAt: new Date(finished).toISOString(), durationMs: Math.max(0, finished - started) });
      if (autoRetry) Object.assign(job, { finishedAt: undefined, durationMs: undefined });
      else Object.assign(job, { finishedAt: new Date(finished).toISOString(), durationMs: finished - started });
      batch.updatedAt = new Date().toISOString();
      await this.persist(batch);
      if (autoRetry) this.schedule(batch, job, resolved);
    }
  }

  private getSemaphore(resolved: ResolvedOffering): Semaphore {
    let semaphore = this.semaphores.get(resolved.profile.id);
    if (!semaphore) {
      semaphore = new Semaphore(resolved.profile.concurrency);
      this.semaphores.set(resolved.profile.id, semaphore);
    }
    return semaphore;
  }

  private requireBatch(id: string): BatchRecord {
    const batch = this.batches.get(id);
    if (!batch) throw new Error(`Unknown image batch: ${id}`);
    return batch;
  }

  private requireAgentJob(batch: BatchRecord, jobId: string): JobRecord {
    const job = batch.jobs.find((entry) => entry.id === jobId);
    if (!job) throw new Error(`Unknown image job: ${jobId}`);
    if ((job.offering || batch.offering).adapterId !== "agent-generation") {
      throw new Error(`${job.name} is not configured for Codex generation.`);
    }
    return job;
  }

  private sortedByRecentActivity(): BatchRecord[] {
    return [...this.batches.values()].sort((a, b) => {
      const activityOrder = b.updatedAt.localeCompare(a.updatedAt);
      return activityOrder || b.createdAt.localeCompare(a.createdAt);
    });
  }

  private activate(batchId: string): void {
    this.activatedBatchId = batchId;
    this.activationRevision = Math.max(Date.now(), this.activationRevision + 1);
  }

  private persist(batch: BatchRecord): Promise<void> {
    const previous = this.saveChains.get(batch.id) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.store.save(batch));
    this.saveChains.set(batch.id, next);
    return next;
  }
}

function resolveBatchImage(batch: BatchRecord, selector: string): SelectedBatchImage {
  const job = batch.jobs.find((entry) => entry.id === selector || entry.name === selector);
  if (job) {
    if (job.status === "succeeded" && job.outputPath) return { kind: "result", job, sourcePath: job.outputPath };
    if (job.status === "failed") {
      const sourcePath = failedSourcePaths(job)[0];
      if (sourcePath) return { kind: "failed-source", job, sourcePath };
    }
    throw new Error(`${job.name} has no completed result or failed-job source available for modification.`);
  }
  for (const owner of batch.jobs) {
    const backup = owner.backups?.find((entry) => entry.id === selector || entry.name === selector);
    if (backup) return { kind: "backup", job: owner, backup, sourcePath: backup.outputPath };
  }
  throw new Error(`Unknown image in batch ${batch.title}: ${selector}`);
}

function resolveImageForDeletion(batch: BatchRecord, selector: string): ImageForDeletion {
  const job = batch.jobs.find((entry) => entry.id === selector || entry.name === selector);
  if (job) return { kind: "job", job };
  for (const owner of batch.jobs) {
    const backup = owner.backups?.find((entry) => entry.id === selector || entry.name === selector);
    if (backup) return { kind: "backup", job: owner, backup };
  }
  throw new Error(`Unknown image in batch ${batch.title}: ${selector}`);
}

function failedSourcePaths(job: JobRecord): string[] {
  if (job.referenceImagePaths?.length) return [...new Set(job.referenceImagePaths)];
  if (job.generationInputPaths?.length) return [...new Set(job.generationInputPaths)];
  if (job.generationInputPath) return [job.generationInputPath];
  if (job.inputPaths?.length) return [...new Set(job.inputPaths)];
  return job.inputPath ? [job.inputPath] : [];
}

function nextBackupVersion(job: JobRecord): number {
  const prefix = `${job.name}-`;
  return Math.max(0, ...(job.backups || []).map((backup) => backup.name.startsWith(prefix) ? Number(backup.name.slice(prefix.length)) || 0 : 0)) + 1;
}

function nextJobSlot(batch: Pick<BatchRecord, "jobs">): { index: number; name: string } {
  const index = Math.max(-1, ...batch.jobs.map((job) => job.index)) + 1;
  const number = Math.max(0, ...batch.jobs.map((job) => /^图(\d+)$/u.exec(job.name)?.[1]).map((value) => Number(value) || 0)) + 1;
  return { index, name: `图${number}` };
}

function allJobPaths(job: JobRecord): string[] {
  return [...new Set([
    job.outputPath,
    job.generationInputPath,
    ...(job.generationInputPaths || []),
    job.inputPath,
    ...(job.inputPaths || []),
    ...(job.referenceImagePaths || []),
    ...(job.backups || []).flatMap((backup) => [backup.outputPath, ...(backup.referenceImagePaths || [])])
  ].filter((value): value is string => Boolean(value)))];
}

function explicitOwnedJobPaths(job: JobRecord, excludedBackupIds = new Set<string>()): string[] {
  return [...new Set([
    job.outputPath,
    job.generationInputPath,
    ...(job.generationInputPaths || []),
    ...(job.backups || []).filter((backup) => !excludedBackupIds.has(backup.id)).map((backup) => backup.outputPath)
  ].filter((value): value is string => Boolean(value)))];
}

function stripJobPaths(job: JobRecord, removedPaths: Set<string>): void {
  const removed = (filePath: string | undefined) => Boolean(filePath && removedPaths.has(path.resolve(filePath)));
  const filter = (values: string[] | undefined) => {
    const kept = values?.filter((filePath) => !removed(filePath));
    return kept?.length ? kept : undefined;
  };
  if (removed(job.inputPath)) job.inputPath = undefined;
  if (removed(job.generationInputPath)) job.generationInputPath = undefined;
  job.inputPaths = filter(job.inputPaths);
  job.referenceImagePaths = filter(job.referenceImagePaths);
  job.generationInputPaths = filter(job.generationInputPaths);
  for (const backup of job.backups || []) backup.referenceImagePaths = filter(backup.referenceImagePaths);
}

async function cloneMergedJob(
  job: JobRecord,
  slot: { index: number; name: string },
  copyPath: (filePath: string | undefined, displayName: string) => Promise<string | undefined>
): Promise<JobRecord> {
  let sourceNumber = 0;
  const copySource = (filePath: string | undefined) => copyPath(filePath, `${slot.name}-source-${++sourceNumber}`);
  const copySources = async (values: string[] | undefined) => values ? Promise.all(values.map((filePath) => copySource(filePath) as Promise<string>)) : undefined;
  const outputPath = await copyPath(job.outputPath, slot.name);
  const backups = job.backups ? await Promise.all(job.backups.map(async (backup, index) => ({
    ...backup,
    id: randomUUID(),
    name: `${slot.name}-${index + 1}`,
    outputPath: (await copyPath(backup.outputPath, `${slot.name}-${index + 1}`))!,
    referenceImagePaths: await copySources(backup.referenceImagePaths),
    offering: backup.offering ? cloneOffering(backup.offering) : undefined
  }))) : undefined;
  return {
    ...job,
    id: randomUUID(),
    index: slot.index,
    name: slot.name,
    inputPath: await copySource(job.inputPath),
    inputPaths: await copySources(job.inputPaths),
    referenceImagePaths: await copySources(job.referenceImagePaths),
    outputPath,
    generationInputPath: await copySource(job.generationInputPath),
    generationInputPaths: await copySources(job.generationInputPaths),
    backups,
    offering: job.offering ? cloneOffering(job.offering) : undefined,
    callHistory: job.callHistory?.map((call) => ({ ...call, id: randomUUID(), offering: cloneOffering(call.offering) }))
  };
}

function cloneOffering(offering: OfferingSnapshot): OfferingSnapshot {
  return { ...offering, price: { ...offering.price } };
}

function snapshot(batch: BatchRecord): BatchSnapshot {
  const counts = {
    queued: batch.jobs.filter((job) => job.status === "queued").length,
    running: batch.jobs.filter((job) => job.status === "running").length,
    succeeded: batch.jobs.filter((job) => job.status === "succeeded").length,
    failed: batch.jobs.filter((job) => job.status === "failed").length,
    canceled: batch.jobs.filter((job) => job.status === "canceled").length
  };
  const estimatedCost = batch.offering.price.mode === "per_request" && typeof batch.offering.price.amount === "number"
    ? Number((batch.offering.price.amount * batch.jobs.length).toFixed(6))
    : undefined;
  return {
    ...batch,
    jobs: batch.jobs.map((job) => ({
      ...job,
      callHistory: job.callHistory?.map((call) => ({ ...call, offering: { ...call.offering, price: { ...call.offering.price } } }))
    })),
    status: deriveStatus(counts, batch.jobs.length),
    total: batch.jobs.length,
    ...counts,
    estimatedCost,
    currency: estimatedCost === undefined ? undefined : batch.offering.price.currency
  };
}

function deriveStatus(counts: { queued: number; running: number; succeeded: number; failed: number; canceled: number }, total: number): BatchStatus {
  if (counts.running || counts.queued) return counts.running ? "running" : "queued";
  if (counts.succeeded === total) return "completed";
  if (counts.failed === total) return "failed";
  if (counts.canceled === total) return "canceled";
  return "partial";
}

function generationInputsFor(job: JobRecord): string[] {
  if (job.generationInputPaths?.length) return [...new Set(job.generationInputPaths)];
  if (job.generationInputPath) return [job.generationInputPath];
  if (job.inputPaths?.length) return [...new Set(job.inputPaths)];
  return job.inputPath ? [job.inputPath] : [];
}

function isAgentGeneration(resolved: ResolvedOffering): boolean {
  return resolved.profile.adapterId === "agent-generation";
}

function beginCall(job: JobRecord, offering: OfferingSnapshot, startedAt: string): JobCallRecord {
  const history = job.callHistory || [];
  const call: JobCallRecord = {
    id: randomUUID(),
    sequence: history.length + 1,
    attempt: job.attempt,
    source: offering.adapterId === "agent-generation" ? "agent" : "provider",
    offering: { ...offering, price: { ...offering.price } },
    status: "running",
    chargeState: "unknown",
    startedAt
  };
  job.callHistory = [...history, call];
  return call;
}

function activeCall(job: JobRecord): JobCallRecord | undefined {
  return [...(job.callHistory || [])].reverse().find((call) => call.status === "running");
}

function finishActiveCall(job: JobRecord, status: JobCallStatus, patch: Partial<JobCallRecord>): void {
  const call = activeCall(job);
  if (call) finishCall(call, status, patch);
}

function finishCall(call: JobCallRecord, status: JobCallStatus, patch: Partial<JobCallRecord>): void {
  Object.assign(call, patch, { status });
}

function migrateLegacyCallHistory(job: JobRecord, offering: OfferingSnapshot): boolean {
  if (job.callHistory?.length) return false;
  const actuallyStarted = Boolean(job.startedAt || job.providerRequestId || job.durationMs !== undefined || job.status === "succeeded" || job.status === "failed");
  if (!actuallyStarted) return false;
  const startedAt = job.startedAt || job.createdAt;
  const call: JobCallRecord = {
    id: randomUUID(),
    sequence: 1,
    attempt: job.attempt,
    source: offering.adapterId === "agent-generation" ? "agent" : "provider",
    offering: { ...offering, price: { ...offering.price } },
    status: legacyCallStatus(job.status),
    chargeState: job.chargeState,
    startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    error: job.error,
    providerRequestId: job.providerRequestId
  };
  job.callHistory = [call];
  return true;
}

function legacyCallStatus(status: JobRecord["status"]): JobCallStatus {
  if (status === "queued") return "canceled";
  return status;
}

function promptFor(input: CreateBatchInput, inputPath: string | undefined, name: string, index: number): string {
  const prompts = input.perImagePrompts || {};
  return prompts[inputPath || ""] || prompts[name] || prompts[String(index + 1)] || prompts[String(index)] || input.prompt;
}

function defaultOutputDirectory(paths: DataPaths, inputDirectory: string | undefined, id: string): string {
  if (inputDirectory) return path.join(path.resolve(inputDirectory), "esse Output", id);
  return path.join(paths.defaultOutputDir, id);
}

function isInside(directory: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
