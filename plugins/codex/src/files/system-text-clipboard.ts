import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TextClipboardCommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<void>;

export async function copyTextToClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
  run: TextClipboardCommandRunner = runCommand,
): Promise<void> {
  if (!text) throw new Error("不能复制空文本。");
  const options = { env: { ...process.env, ESSE_CLIPBOARD_TEXT: text } };
  if (platform === "win32") {
    const encoded = Buffer.from(WINDOWS_CLIPBOARD_SCRIPT, "utf16le").toString("base64");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], options);
    return;
  }
  if (platform === "darwin") {
    await run("osascript", ["-e", MAC_CLIPBOARD_SCRIPT], options);
    return;
  }
  throw new Error("当前系统暂不支持把文本复制到剪贴板。");
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
$text = $env:ESSE_CLIPBOARD_TEXT
for ($attempt = 0; $attempt -lt 5; $attempt++) {
  try {
    [System.Windows.Clipboard]::SetText($text)
    exit 0
  } catch {
    if ($attempt -eq 4) { throw }
    Start-Sleep -Milliseconds 80
  }
}
`;

const MAC_CLIPBOARD_SCRIPT = String.raw`set the clipboard to system attribute "ESSE_CLIPBOARD_TEXT"`;
