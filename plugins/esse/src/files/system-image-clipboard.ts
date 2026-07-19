import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ClipboardCommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<void>;

export async function copyImageFileToClipboard(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  run: ClipboardCommandRunner = runCommand,
): Promise<void> {
  const sourcePath = path.resolve(filePath);
  await access(sourcePath);
  if (platform === "win32") {
    await copyOnWindows(sourcePath, run);
    return;
  }
  if (platform === "darwin") {
    await copyOnMac(sourcePath, run);
    return;
  }
  throw new Error("当前系统暂不支持把图片复制到剪贴板。");
}

async function copyOnWindows(filePath: string, run: ClipboardCommandRunner): Promise<void> {
  const encoded = Buffer.from(WINDOWS_CLIPBOARD_SCRIPT, "utf16le").toString("base64");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], {
    env: { ...process.env, ESSE_CLIPBOARD_IMAGE_PATH: filePath },
  });
}

async function copyOnMac(filePath: string, run: ClipboardCommandRunner): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "esse-clipboard-"));
  const pngPath = path.join(tempDirectory, "clipboard.png");
  try {
    await run("sips", ["-s", "format", "png", filePath, "--out", pngPath]);
    await run("osascript", ["-e", MAC_CLIPBOARD_SCRIPT, pngPath]);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function runCommand(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<void> {
  await execFileAsync(command, args, {
    env: options?.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

const WINDOWS_CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
$imagePath = $env:ESSE_CLIPBOARD_IMAGE_PATH
$image = New-Object System.Windows.Media.Imaging.BitmapImage
$image.BeginInit()
$image.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$image.UriSource = New-Object System.Uri($imagePath)
$image.EndInit()
$image.Freeze()
for ($attempt = 0; $attempt -lt 5; $attempt++) {
  try {
    [System.Windows.Clipboard]::SetImage($image)
    exit 0
  } catch {
    if ($attempt -eq 4) { throw }
    Start-Sleep -Milliseconds 80
  }
}
`;

const MAC_CLIPBOARD_SCRIPT = String.raw`on run argv
set imageFile to POSIX file (item 1 of argv)
set the clipboard to (read imageFile as «class PNGf»)
end run`;
