import { execFile } from "node:child_process";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SavePathPicker = (suggestedName: string) => Promise<string | undefined>;

export async function saveFileAs(
  sourcePath: string,
  suggestedName: string,
  pickPath: SavePathPicker = pickSavePath,
): Promise<string | undefined> {
  const safeName = safeFileName(suggestedName);
  const selected = await pickPath(safeName);
  if (!selected) return undefined;
  const source = path.resolve(sourcePath);
  const destination = withDefaultExtension(path.resolve(selected), path.extname(safeName));
  if (source !== destination) await copyFile(source, destination);
  return destination;
}

export async function pickSavePath(suggestedName: string): Promise<string | undefined> {
  if (process.platform === "win32") return pickWindowsPath(suggestedName);
  if (process.platform === "darwin") return pickMacPath(suggestedName);
  return pickLinuxPath(suggestedName);
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return cleaned || "image.png";
}

function withDefaultExtension(filePath: string, extension: string): string {
  return extension && !path.extname(filePath) ? `${filePath}${extension}` : filePath;
}

async function pickWindowsPath(suggestedName: string): Promise<string | undefined> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = '保存图片'
$dialog.FileName = $env:ESSE_SAVE_SUGGESTED_NAME
$extension = [System.IO.Path]::GetExtension($dialog.FileName).TrimStart('.')
if ($extension) {
  $dialog.DefaultExt = $extension
  $dialog.Filter = ($extension.ToUpperInvariant() + ' 图片|*.' + $extension + '|所有文件|*.*')
} else {
  $dialog.Filter = '图片文件|*.png;*.jpg;*.jpeg;*.webp|所有文件|*.*'
}
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Write($dialog.FileName)
}
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded], {
    encoding: "utf8",
    env: { ...process.env, ESSE_SAVE_SUGGESTED_NAME: suggestedName },
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim() || undefined;
}

async function pickMacPath(suggestedName: string): Promise<string | undefined> {
  const script = "on run argv\nset chosenFile to choose file name with prompt \"保存图片\" default name (item 1 of argv)\nreturn POSIX path of chosenFile\nend run";
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script, suggestedName], { encoding: "utf8" });
    return stdout.trim() || undefined;
  } catch (error) {
    if (isCanceled(error)) return undefined;
    throw error;
  }
}

async function pickLinuxPath(suggestedName: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("zenity", ["--file-selection", "--save", "--confirm-overwrite", `--filename=${suggestedName}`], { encoding: "utf8" });
    return stdout.trim() || undefined;
  } catch (error) {
    if (isCanceled(error)) return undefined;
    throw new Error("当前桌面环境无法打开保存窗口，请安装 zenity 后重试。");
  }
}

function isCanceled(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && Number((error as { code?: unknown }).code) === 1);
}
