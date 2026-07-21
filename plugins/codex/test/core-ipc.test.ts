import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CORE_LOCK_FILE, acquireCoreLock, ensureCoreToken, resolveCoreEndpoint } from "../src/core/ipc.js";

test("Core IPC identity and capability token are stable for one data root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-core-ipc-"));
  try {
    const [first, second] = await Promise.all([ensureCoreToken(root), ensureCoreToken(root)]);
    assert.equal(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{40,}$/u);
    assert.equal(resolveCoreEndpoint(root, "win32"), resolveCoreEndpoint(root, "win32"));
    assert.match(resolveCoreEndpoint(root, "win32"), /^\\\\\.\\pipe\\esse-core-[a-f0-9]{24}$/u);
    assert.notEqual(resolveCoreEndpoint(root, "win32"), resolveCoreEndpoint(`${root}-other`, "win32"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Core lock admits one owner and recovers a stale owner record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-core-lock-"));
  try {
    const first = await acquireCoreLock(root, "0.2.4");
    assert(first);
    assert.equal(await acquireCoreLock(root, "0.2.4"), undefined);
    await first.release();

    await writeFile(path.join(root, CORE_LOCK_FILE), JSON.stringify({ pid: 2147483647, pluginVersion: "stale" }), "utf8");
    const recovered = await acquireCoreLock(root, "0.2.4");
    assert(recovered);
    await recovered.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
