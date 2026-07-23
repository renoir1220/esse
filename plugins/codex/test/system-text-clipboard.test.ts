import assert from "node:assert/strict";
import test from "node:test";
import { copyTextToClipboard } from "../src/files/system-text-clipboard.js";

test("Windows text clipboard uses an STA PowerShell process and an environment value", async () => {
  const calls: Array<{ command: string; args: string[]; text?: string }> = [];
  await copyTextToClipboard("批次名称：测试", "win32", async (command, args, options) => {
    calls.push({ command, args, text: options?.env?.ESSE_CLIPBOARD_TEXT });
  });
  assert.equal(calls[0]?.command, "powershell.exe");
  assert(calls[0]?.args.includes("-STA"));
  assert(calls[0]?.args.includes("-EncodedCommand"));
  assert.equal(calls[0]?.text, "批次名称：测试");
});

test("macOS text clipboard passes the value through the environment", async () => {
  const calls: Array<{ command: string; args: string[]; text?: string }> = [];
  await copyTextToClipboard("imageId: image-1", "darwin", async (command, args, options) => {
    calls.push({ command, args, text: options?.env?.ESSE_CLIPBOARD_TEXT });
  });
  assert.equal(calls[0]?.command, "osascript");
  assert.equal(calls[0]?.text, "imageId: image-1");
});

test("text clipboard rejects empty text and unsupported platforms", async () => {
  await assert.rejects(copyTextToClipboard("", "win32", async () => {}), /空文本/);
  await assert.rejects(copyTextToClipboard("text", "linux", async () => {}), /暂不支持/);
});
