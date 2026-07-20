import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface ThumbnailCachePruneResult {
  scanned: number;
  removed: number;
  remainingBytes: number;
}

export async function pruneThumbnailCache(
  directory: string,
  options: { maxBytes?: number; maxAgeMs?: number; now?: number } = {}
): Promise<ThumbnailCachePruneResult> {
  const maxBytes = Math.max(0, options.maxBytes ?? 512 * 1024 * 1024);
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000);
  const now = options.now ?? Date.now();
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    const info = await stat(filePath);
    return { filePath, size: info.size, modifiedAt: info.mtimeMs };
  }));
  let removed = 0;
  let remainingBytes = 0;
  const retained: typeof files = [];
  for (const file of files) {
    if (now - file.modifiedAt > maxAgeMs) {
      await rm(file.filePath, { force: true });
      removed += 1;
    } else {
      retained.push(file);
      remainingBytes += file.size;
    }
  }
  retained.sort((a, b) => a.modifiedAt - b.modifiedAt);
  for (const file of retained) {
    if (remainingBytes <= maxBytes) break;
    await rm(file.filePath, { force: true });
    remainingBytes -= file.size;
    removed += 1;
  }
  return { scanned: files.length, removed, remainingBytes };
}
