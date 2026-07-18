import { access, copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DataPaths } from "../paths.js";
import { mimeForPath, thumbnailCacheName } from "./image-files.js";

export class Thumbnailer {
  constructor(private readonly paths: DataPaths, private readonly platform = process.platform) {}

  async dataUrl(filePath: string, maxDimension = 720): Promise<string | undefined> {
    const source = await stat(filePath);
    const target = path.join(this.paths.thumbnailsDir, thumbnailCacheName(filePath, source.mtime.toISOString(), maxDimension));
    try { await access(target); }
    catch {
      try {
        await this.create(filePath, target, maxDimension);
        await access(target);
      }
      catch {
        if (source.size > 5 * 1024 * 1024) return undefined;
        await copyFile(filePath, target);
      }
    }
    const mime = target.endsWith(".jpg") ? "image/jpeg" : mimeForPath(target);
    return `data:${mime};base64,${(await readFile(target)).toString("base64")}`;
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
