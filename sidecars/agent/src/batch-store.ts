import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BatchRecord } from './types';

export class BatchStore {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  async loadAll(): Promise<BatchRecord[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const batches: BatchRecord[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const filePath = path.join(this.directory, name);
      try {
        const batch = await this.read(filePath);
        if (!batch || !isBatchRecord(batch)) throw new Error('The batch record does not match the supported schema.');
        batches.push(batch);
      } catch (error) {
        await this.quarantine(filePath, name, error);
      }
    }
    return batches.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async save(batch: BatchRecord): Promise<void> {
    const id = validId(batch.id);
    const previous = this.writeQueues.get(id) ?? Promise.resolve();
    const task = previous.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const destination = this.fileFor(id);
      const temporary = `${destination}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(batch, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, destination);
    });
    this.writeQueues.set(id, task.then(() => undefined, () => undefined));
    await task;
  }

  async delete(id: string): Promise<void> {
    const valid = validId(id);
    await this.writeQueues.get(valid);
    await rm(this.fileFor(valid), { force: true });
  }

  private async read(filePath: string): Promise<BatchRecord | undefined> {
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as BatchRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private fileFor(id: string): string {
    return path.join(this.directory, `${validId(id)}.json`);
  }

  private async quarantine(filePath: string, name: string, error: unknown): Promise<void> {
    const quarantineDirectory = path.join(this.directory, '.quarantine');
    const destination = path.join(quarantineDirectory, `${Date.now()}-${randomUUID()}-${name}`);
    try {
      await mkdir(quarantineDirectory, { recursive: true });
      await rename(filePath, destination);
      process.stderr.write(`[esse] quarantined unreadable batch record ${name}: ${errorMessage(error)}\n`);
    } catch (quarantineError) {
      process.stderr.write(`[esse] could not load or quarantine batch record ${name}: ${errorMessage(quarantineError)}\n`);
    }
  }
}

function validId(id: string): string {
  if (!/^[a-f0-9-]{20,}$/i.test(id)) throw new Error('Invalid batch ID.');
  return id;
}

function isBatchRecord(value: unknown): value is BatchRecord {
  if (!value || typeof value !== 'object') return false;
  const batch = value as Partial<BatchRecord>;
  return typeof batch.id === 'string'
    && /^[a-f0-9-]{20,}$/i.test(batch.id)
    && typeof batch.title === 'string'
    && typeof batch.prompt === 'string'
    && typeof batch.createdAt === 'string'
    && typeof batch.updatedAt === 'string'
    && Boolean(batch.offering && typeof batch.offering.id === 'string' && typeof batch.offering.providerType === 'string')
    && Array.isArray(batch.jobs)
    && batch.jobs.every((job) => Boolean(job
      && typeof job.id === 'string'
      && typeof job.name === 'string'
      && typeof job.status === 'string'
      && typeof job.prompt === 'string'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
