import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyImageFileToClipboard } from "../src/files/system-image-clipboard.js";

test("Windows image clipboard uses an STA PowerShell process and an environment path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-clipboard-test-"));
  const imagePath = path.join(root, "sample image.png");
  await writeFile(imagePath, "image");
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  try {
    await copyImageFileToClipboard(imagePath, "win32", async (command, args, options) => {
      calls.push({ command, args, env: options?.env });
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "powershell.exe");
    assert(calls[0]?.args.includes("-STA"));
    assert(calls[0]?.args.includes("-EncodedCommand"));
    assert.equal(calls[0]?.env?.ESSE_CLIPBOARD_IMAGE_PATH, path.resolve(imagePath));
    assert(!calls[0]?.args.join(" ").includes(imagePath), "local paths must not be interpolated into commands");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS image clipboard normalizes through sips before writing PNG data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-clipboard-test-"));
  const imagePath = path.join(root, "sample.webp");
  await writeFile(imagePath, "image");
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    await copyImageFileToClipboard(imagePath, "darwin", async (command, args) => {
      calls.push({ command, args });
    });
    assert.deepEqual(calls.map((call) => call.command), ["sips", "osascript"]);
    assert.deepEqual(calls[0]?.args.slice(0, 4), ["-s", "format", "png", path.resolve(imagePath)]);
    assert(calls[1]?.args.at(-1)?.endsWith("clipboard.png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image clipboard rejects unsupported desktop platforms", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-clipboard-test-"));
  const imagePath = path.join(root, "sample.png");
  await writeFile(imagePath, "image");
  try {
    await assert.rejects(copyImageFileToClipboard(imagePath, "linux", async () => {}), /暂不支持/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
