import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const THUMBNAIL_LONG_EDGE = 512;
export const DEFAULT_THUMBNAIL_CACHE_BYTES = 256 * 1024 * 1024;
const CACHE_VERSION = 1;
const TOUCH_INTERVAL_MS = 60 * 60_000;

type ThumbnailGenerator = (sourcePath: string, maxDimension: number) => Buffer | Promise<Buffer>;

export class ThumbnailStore {
  private readonly pending = new Map<string, Promise<string>>();
  private readonly lastTouched = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly cacheDirectory: string,
    private readonly generate: ThumbnailGenerator,
    private readonly maxCacheBytes = DEFAULT_THUMBNAIL_CACHE_BYTES,
  ) {}

  async ensure(sourcePath: string): Promise<string> {
    const source = path.resolve(sourcePath);
    const sourceDetails = await stat(source);
    if (!sourceDetails.isFile() || sourceDetails.size <= 0) throw new Error('Thumbnail source is not a readable image file.');
    const key = createHash('sha256')
      .update(`${CACHE_VERSION}\0${source}\0${sourceDetails.size}\0${sourceDetails.mtimeMs}`)
      .digest('hex');
    const destination = path.join(this.cacheDirectory, `${key}.png`);
    if (await fileExists(destination)) {
      this.touchSoon(destination);
      return destination;
    }

    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.enqueue(async () => {
      if (await fileExists(destination)) return destination;
      await mkdir(this.cacheDirectory, { recursive: true });
      const bytes = await this.generate(source, THUMBNAIL_LONG_EDGE);
      if (!bytes.length) throw new Error('Thumbnail generator returned an empty image.');
      const temporary = path.join(this.cacheDirectory, `.${key}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { mode: 0o600 });
        await rename(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      await this.prune(destination);
      return destination;
    });
    this.pending.set(key, task);
    void task.finally(() => this.pending.delete(key)).catch(() => undefined);
    return task;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async prune(protectedPath: string): Promise<void> {
    if (this.maxCacheBytes <= 0) return;
    const names = await readdir(this.cacheDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const entries = (await Promise.all(names.filter((name) => name.endsWith('.png')).map(async (name) => {
      const filePath = path.join(this.cacheDirectory, name);
      const details = await stat(filePath).catch(() => undefined);
      return details?.isFile() ? { filePath, size: details.size, usedAt: details.mtimeMs } : undefined;
    }))).filter(Boolean) as Array<{ filePath: string; size: number; usedAt: number }>;
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.maxCacheBytes) return;
    for (const entry of entries.sort((left, right) => left.usedAt - right.usedAt)) {
      if (total <= this.maxCacheBytes) break;
      if (path.resolve(entry.filePath) === path.resolve(protectedPath)) continue;
      try {
        await unlink(entry.filePath);
        total -= entry.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private touchSoon(filePath: string): void {
    const now = Date.now();
    const previous = this.lastTouched.get(filePath) ?? 0;
    if (now - previous < TOUCH_INTERVAL_MS) return;
    this.lastTouched.set(filePath, now);
    const touched = new Date(now);
    void utimes(filePath, touched, touched).catch(() => undefined);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
