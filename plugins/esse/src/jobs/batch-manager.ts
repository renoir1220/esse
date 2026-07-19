import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import type { DataPaths } from "../paths.js";
import { imageFileToDataUrl } from "../files/image-files.js";
import { backupImageVersion, saveGeneratedImage } from "../files/output-files.js";
import type { BatchRecord, BatchSnapshot, BatchStatus, JobRecord, ProviderRequestError } from "../types.js";
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
const AUTO_RETRY_LIMIT = 3;

export class BatchManager {
  private readonly batches = new Map<string, BatchRecord>();
  private readonly requestKeys = new Map<string, string>();
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly runtimeOptions = new Map<string, RuntimeJobOptions>();
  private readonly saveChains = new Map<string, Promise<void>>();

  constructor(
    private readonly store: BatchStore,
    private readonly registry: ProviderRegistry,
    private readonly paths: DataPaths
  ) {}

  async initialize(): Promise<void> {
    for (const batch of await this.store.loadAll()) {
      let changed = false;
      for (const job of batch.jobs) {
        const chineseName = `图${job.index + 1}`;
        if (job.name !== chineseName) {
          job.name = chineseName;
          changed = true;
        }
        if (job.status === "running") {
          Object.assign(job, {
            status: "failed",
            progress: 100,
            retryable: true,
            chargeState: "unknown",
            error: "The local plugin stopped while this provider request was running. Review billing before retrying.",
            finishedAt: new Date().toISOString()
          });
          changed = true;
        } else if (job.status === "queued") {
          Object.assign(job, {
            status: "canceled",
            progress: 0,
            chargeState: "not_charged",
            error: "Canceled because the local plugin restarted before this job began.",
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
    if (existingId) return this.get(existingId);
    const resolved = await this.registry.resolveOffering(input.offeringId);
    if (!resolved.profile.hasApiKey) throw new Error(`Provider ${resolved.profile.displayName} · ${resolved.profile.tierName} has no API key.`);
    const imagePaths = (input.imagePaths || []).map((value) => path.resolve(value));
    const referenceImagePaths = [...new Set((input.referenceImagePaths || []).map((value) => path.resolve(value)))];
    const jobInputs = (input.jobs || []).slice(0, 50);
    const count = jobInputs.length || imagePaths.length || Math.max(1, Math.trunc(input.count || 1));
    if (count > 50) throw new Error("A batch can contain at most 50 jobs.");
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
    for (const job of jobs) this.schedule(batch, job, resolved);
    return snapshot(batch);
  }

  async modifyInPlace(options: {
    batchId: string;
    jobIds: string[];
    instructions: string;
    offeringId?: string;
    outputDirectory?: string;
    requestKey?: string;
  }): Promise<BatchSnapshot> {
    const source = this.requireBatch(options.batchId);
    if (options.requestKey && source.modificationKeys?.[options.requestKey]) return snapshot(source);
    const selected = source.jobs.filter((job) => options.jobIds.includes(job.id));
    if (!selected.length) throw new Error("No matching image jobs were selected.");
    if (selected.some((job) => job.status !== "succeeded" || !job.outputPath)) throw new Error("Only completed images can be modified.");
    const resolved = await this.registry.resolveOffering(options.offeringId || source.offering.id);
    if (!resolved.profile.hasApiKey) throw new Error(`Provider ${resolved.profile.displayName} · ${resolved.profile.tierName} has no API key.`);
    if (!resolved.offering.supportsImageToImage) throw new Error(`${resolved.offering.displayName} does not support image editing.`);
    const now = new Date().toISOString();
    for (const job of selected) {
      const version = (job.backups?.length || 0) + 1;
      const backupName = `${job.name}-${version}`;
      const currentOutput = job.outputPath!;
      const backupPath = await backupImageVersion({ sourcePath: currentOutput, outputDirectory: source.outputDirectory, displayName: backupName });
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
        generationInputPath: currentOutput,
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
    }
    if (options.requestKey) {
      source.modificationKeys = { ...(source.modificationKeys || {}), [options.requestKey]: selected.map((job) => job.id) };
    }
    source.updatedAt = now;
    await this.persist(source);
    for (const job of selected) this.schedule(source, job, resolved);
    return snapshot(source);
  }

  list(limit = 20): BatchSnapshot[] {
    return [...this.batches.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map(snapshot);
  }

  listRecent(limit = 20): BatchSnapshot[] {
    return this.sortedByRecentActivity()
      .slice(0, Math.max(1, Math.min(100, limit)))
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
        startedAt: undefined,
        finishedAt: undefined,
        durationMs: undefined,
        attempt: job.attempt + 1
      });
      const resolved = await this.registry.resolveOffering(job.offering?.id || batch.offering.id);
      this.schedule(batch, job, resolved);
    }
    batch.updatedAt = new Date().toISOString();
    await this.persist(batch);
    return snapshot(batch);
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

  private schedule(batch: BatchRecord, job: JobRecord, resolved: ResolvedOffering): void {
    const semaphore = this.getSemaphore(resolved);
    void semaphore.use(async () => {
      if (job.status !== "queued") return;
      await this.runJob(batch, job, resolved);
    });
  }

  private async runJob(batch: BatchRecord, job: JobRecord, resolved: ResolvedOffering): Promise<void> {
    const started = Date.now();
    Object.assign(job, { status: "running", progress: 15, chargeState: "unknown", startedAt: new Date(started).toISOString() });
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
    } catch (error) {
      const providerError = error instanceof ProviderError ? error as ProviderRequestError : undefined;
      Object.assign(job, {
        status: "failed",
        progress: 100,
        retryable: providerError?.details.retryable ?? false,
        chargeState: providerError?.details.chargeState ?? "unknown",
        error: error instanceof Error ? error.message : "Unknown local image generation error"
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

  private sortedByRecentActivity(): BatchRecord[] {
    return [...this.batches.values()].sort((a, b) => {
      const activityOrder = b.updatedAt.localeCompare(a.updatedAt);
      return activityOrder || b.createdAt.localeCompare(a.createdAt);
    });
  }

  private persist(batch: BatchRecord): Promise<void> {
    const previous = this.saveChains.get(batch.id) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.store.save(batch));
    this.saveChains.set(batch.id, next);
    return next;
  }
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
    jobs: batch.jobs.map((job) => ({ ...job })),
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
