import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

export interface DataPaths {
  root: string;
  settingsFile: string;
  secretsDir: string;
  batchesDir: string;
  thumbnailsDir: string;
  defaultOutputDir: string;
}

export function resolveDataPaths(env: NodeJS.ProcessEnv = process.env, platform = process.platform): DataPaths {
  const override = env.ESSE_DATA_DIR?.trim();
  let root: string;
  if (override) root = path.resolve(override);
  else if (platform === "win32") root = path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "esse");
  else if (platform === "darwin") root = path.join(os.homedir(), "Library", "Application Support", "esse");
  else root = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "esse");

  return {
    root,
    settingsFile: path.join(root, "settings.json"),
    secretsDir: path.join(root, "secrets"),
    batchesDir: path.join(root, "batches"),
    thumbnailsDir: path.join(root, "thumbnails"),
    defaultOutputDir: path.join(root, "outputs")
  };
}

export async function ensureDataPaths(paths: DataPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.secretsDir, { recursive: true }),
    mkdir(paths.batchesDir, { recursive: true }),
    mkdir(paths.thumbnailsDir, { recursive: true }),
    mkdir(paths.defaultOutputDir, { recursive: true })
  ]);
}
