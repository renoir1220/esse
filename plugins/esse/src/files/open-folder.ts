import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

export interface FolderOpenInvocation {
  command: string;
  args: string[];
  options: {
    detached: true;
    stdio: "ignore";
    windowsHide?: boolean;
  };
}

export async function openLocalFolder(folderPath: string, platform = process.platform): Promise<void> {
  const resolved = path.resolve(folderPath);
  const folderStat = await stat(resolved);
  if (!folderStat.isDirectory()) throw new Error("Batch output path is not a folder.");
  const { command, args, options } = folderOpenInvocation(resolved, platform);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export function folderOpenInvocation(resolvedFolder: string, platform: NodeJS.Platform): FolderOpenInvocation {
  if (platform === "win32") {
    return {
      command: "explorer.exe",
      args: [resolvedFolder],
      options: { detached: true, stdio: "ignore", windowsHide: false },
    };
  }
  if (platform === "darwin") {
    return {
      command: "/usr/bin/open",
      args: [resolvedFolder],
      options: { detached: true, stdio: "ignore" },
    };
  }
  throw new Error(`Opening folders is not supported on ${platform}.`);
}
