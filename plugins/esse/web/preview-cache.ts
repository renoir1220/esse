export class DataUrlLruCache {
  private readonly values = new Map<string, string>();
  private totalChars = 0;

  constructor(private readonly maxChars = 32 * 1024 * 1024) {
    if (!Number.isFinite(maxChars) || maxChars < 0) throw new Error("Preview cache size must be non-negative.");
  }

  get(key: string): string | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    const previous = this.values.get(key);
    if (previous !== undefined) this.totalChars -= previous.length;
    this.values.delete(key);
    if (this.maxChars === 0 || value.length > this.maxChars) return;
    this.values.set(key, value);
    this.totalChars += value.length;
    while (this.totalChars > this.maxChars) {
      const oldest = this.values.entries().next().value as [string, string] | undefined;
      if (!oldest) break;
      this.values.delete(oldest[0]);
      this.totalChars -= oldest[1].length;
    }
  }

  get size(): number { return this.values.size; }
  get chars(): number { return this.totalChars; }
}

export interface PreviewJobVersion {
  attempt: number;
  status: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export function jobPreviewRevision(job: PreviewJobVersion): string {
  return [job.attempt, job.status, job.finishedAt || job.startedAt || job.createdAt].join(":");
}

export function versionedPreviewSignature(filePath: string, revision: string): string {
  return `${filePath}\u001e${revision}`;
}

export function jobFileSignature(job: PreviewJobVersion, filePath: string): string {
  return versionedPreviewSignature(filePath, jobPreviewRevision(job));
}
