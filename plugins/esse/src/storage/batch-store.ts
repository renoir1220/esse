import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { BatchRecord } from "../types.js";
import { readJsonFile, writeJsonFile } from "./atomic-json.js";

export class BatchStore {
  constructor(private readonly batchesDir: string) {}

  async loadAll(): Promise<BatchRecord[]> {
    const names = await readdir(this.batchesDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const batches = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJsonFile<BatchRecord>(path.join(this.batchesDir, name)))
    );
    return batches.filter((batch): batch is BatchRecord => Boolean(batch)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
}
