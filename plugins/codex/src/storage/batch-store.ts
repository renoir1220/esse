import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { BatchRecord, GenerateResult } from "../types.js";
import { readJsonFile, writeJsonFile } from "./atomic-json.js";

export class BatchStore {
  constructor(private readonly batchesDir: string) {}

  async saveProviderResult(callId: string, result: GenerateResult): Promise<void> {
    const destination = this.resultFileFor(callId);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeJsonFile(destination, result);
  }

  async loadProviderResult(callId: string): Promise<GenerateResult | undefined> {
    try {
      const result = await readJsonFile<GenerateResult>(this.resultFileFor(callId));
      if (result && typeof result.outputUrl !== "string" && typeof result.b64Json !== "string") throw new Error("Invalid saved Provider result.");
      return result;
    } catch (error) {
      throw new Error("Saved Provider result could not be read; no new generation was submitted.", { cause: error });
    }
  }

  async deleteProviderResult(callId: string): Promise<void> {
    await rm(this.resultFileFor(callId), { force: true });
  }

  private resultFileFor(callId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(callId)) throw new Error("Invalid Provider call ID.");
    return path.join(this.batchesDir, ".provider-results", `${callId}.json`);
  }

  async loadAll(): Promise<BatchRecord[]> {
    const names = await readdir(this.batchesDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const batches: BatchRecord[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const filePath = path.join(this.batchesDir, name);
      try {
        const batch = await readJsonFile<BatchRecord>(filePath);
        if (batch && isBatchRecord(batch)) batches.push(batch);
        else throw new Error("The batch record does not match the supported schema.");
      } catch (error) {
        await this.quarantine(filePath, name, error);
      }
    }
    return batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<BatchRecord | undefined> {
    return readJsonFile<BatchRecord>(this.fileFor(id));
  }

  async save(batch: BatchRecord): Promise<void> {
    await writeJsonFile(this.fileFor(batch.id), batch);
  }

  async delete(id: string): Promise<void> {
    await rm(this.fileFor(id), { force: true });
  }

  private fileFor(id: string): string {
    if (!/^[a-f0-9-]{20,}$/i.test(id)) throw new Error("Invalid batch ID.");
    return path.join(this.batchesDir, `${id}.json`);
  }

  private async quarantine(filePath: string, name: string, error: unknown): Promise<void> {
    const directory = path.join(this.batchesDir, ".quarantine");
    const destination = path.join(directory, `${Date.now()}-${randomUUID()}-${name}`);
    try {
      await mkdir(directory, { recursive: true });
      await rename(filePath, destination);
      process.stderr.write(`[esse] quarantined unreadable batch record ${name}: ${errorMessage(error)}\n`);
    } catch (quarantineError) {
      process.stderr.write(`[esse] could not load or quarantine batch record ${name}: ${errorMessage(quarantineError)}\n`);
    }
  }
}

function isBatchRecord(value: unknown): value is BatchRecord {
  if (!value || typeof value !== "object") return false;
  const batch = value as Partial<BatchRecord>;
  return typeof batch.id === "string"
    && /^[a-f0-9-]{20,}$/i.test(batch.id)
    && typeof batch.title === "string"
    && typeof batch.prompt === "string"
    && typeof batch.outputDirectory === "string"
    && typeof batch.createdAt === "string"
    && typeof batch.updatedAt === "string"
    && Boolean(batch.offering && typeof batch.offering.id === "string" && typeof batch.offering.adapterId === "string")
    && Array.isArray(batch.jobs)
    && batch.jobs.every((job) => Boolean(job
      && typeof job.id === "string"
      && typeof job.name === "string"
      && typeof job.status === "string"
      && typeof job.prompt === "string"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
