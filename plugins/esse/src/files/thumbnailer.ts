import { access, copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DataPaths } from "../paths.js";
import { mimeForPath, thumbnailCacheName } from "./image-files.js";

export interface ThumbnailerOptions {
  maxConcurrentGenerations?: number;
  maxMemoryCacheChars?: number;
  createThumbnail?: (input: string, output: string, maxDimension: number) => Promise<void>;
}

export class Thumbnailer {
  private readonly generationPool: TaskPool;
  private readonly memoryCache = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string | undefined>>();
  private readonly maxMemoryCacheChars: number;
  private readonly createThumbnail: (input: string, output: string, maxDimension: number) => Promise<void>;
  private memoryCacheChars = 0;

  constructor(
    private readonly paths: DataPaths,
    private readonly platform = process.platform,
    options: ThumbnailerOptions = {}
  ) {
    this.generationPool = new TaskPool(options.maxConcurrentGenerations ?? 4);
    this.maxMemoryCacheChars = Math.max(0, options.maxMemoryCacheChars ?? 32 * 1024 * 1024);
    this.createThumbnail = options.createThumbnail ?? ((input, output, maxDimension) => this.create(input, output, maxDimension));
  }

  async dataUrl(filePath: string, maxDimension = 720): Promise<string | undefined> {
    const source = await stat(filePath);
    const target = path.join(this.paths.thumbnailsDir, thumbnailCacheName(filePath, source.mtime.toISOString(), maxDimension));
    const cached = this.memoryCache.get(target);
    if (cached !== undefined) {
      this.memoryCache.delete(target);
      this.memoryCache.set(target, cached);
      return cached;
    }

    const existing = this.inFlight.get(target);
    if (existing) return existing;
    const pending = this.loadDataUrl(filePath, target, maxDimension, source.size);
    this.inFlight.set(target, pending);
    try {
      const dataUrl = await pending;
      if (dataUrl) this.remember(target, dataUrl);
      return dataUrl;
    } finally {
      if (this.inFlight.get(target) === pending) this.inFlight.delete(target);
    }
  }

  private async loadDataUrl(filePath: string, target: string, maxDimension: number, sourceSize: number): Promise<string | undefined> {
    try { await access(target); }
    catch {
      await this.generationPool.use(async () => {
        try { await access(target); }
        catch {
          try {
            await this.createThumbnail(filePath, target, maxDimension);
            await access(target);
          }
          catch {
            if (sourceSize > 5 * 1024 * 1024) return;
            await copyFile(filePath, target);
          }
        }
      });
    }
    try {
      const mime = target.endsWith(".jpg") ? "image/jpeg" : mimeForPath(target);
      return `data:${mime};base64,${(await readFile(target)).toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  private remember(key: string, dataUrl: string): void {
    if (this.maxMemoryCacheChars === 0 || dataUrl.length > this.maxMemoryCacheChars) return;
    const previous = this.memoryCache.get(key);
    if (previous !== undefined) this.memoryCacheChars -= previous.length;
    this.memoryCache.delete(key);
    this.memoryCache.set(key, dataUrl);
    this.memoryCacheChars += dataUrl.length;
    while (this.memoryCacheChars > this.maxMemoryCacheChars) {
      const oldest = this.memoryCache.entries().next().value as [string, string] | undefined;
      if (!oldest) break;
      this.memoryCache.delete(oldest[0]);
      this.memoryCacheChars -= oldest[1].length;
    }
  }

  private async create(input: string, output: string, maxDimension: number): Promise<void> {
    if (this.platform === "darwin") {
      await run("sips", ["-Z", String(maxDimension), "-s", "format", "jpeg", input, "--out", output]);
      return;
    }
    if (this.platform === "win32") {
      await runPowerShell(WINDOWS_THUMBNAIL_SCRIPT, [input, output, String(maxDimension)]);
      return;
    }
    throw new Error(`Thumbnail generation is not implemented for ${this.platform}.`);
  }
}

async function runPowerShell(script: string, args: string[]): Promise<void> {
  let lastError: unknown;
  for (const command of ["powershell.exe", "pwsh.exe"]) {
    try {
      await run(command, ["-NoProfile", "-NonInteractive", "-Command", script], {
        ...process.env,
        ESSE_THUMB_INPUT: args[0],
        ESSE_THUMB_OUTPUT: args[1],
        ESSE_THUMB_MAX: args[2]
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("PowerShell is required to create thumbnails on Windows.");
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with ${code}`)));
  });
}

const WINDOWS_THUMBNAIL_SCRIPT = String.raw`Add-Type -AssemblyName System.Drawing; $inputPath=$env:ESSE_THUMB_INPUT; $outputPath=$env:ESSE_THUMB_OUTPUT; $max=[int]$env:ESSE_THUMB_MAX; $image=[Drawing.Image]::FromFile($inputPath); try { $scale=[Math]::Min(1.0,[Math]::Min($max/$image.Width,$max/$image.Height)); $w=[Math]::Max(1,[int]($image.Width*$scale)); $h=[Math]::Max(1,[int]($image.Height*$scale)); $bitmap=New-Object Drawing.Bitmap($w,$h); try { $graphics=[Drawing.Graphics]::FromImage($bitmap); try { $graphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $graphics.DrawImage($image,0,0,$w,$h) } finally { $graphics.Dispose() }; $bitmap.Save($outputPath,[Drawing.Imaging.ImageFormat]::Jpeg) } finally { $bitmap.Dispose() } } finally { $image.Dispose() }`;

class TaskPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Task pool limit must be a positive integer.");
  }

  async use<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await task(); }
    finally { this.release(); }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(() => { this.active += 1; resolve(); }));
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}
