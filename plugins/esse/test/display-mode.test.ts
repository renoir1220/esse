import assert from "node:assert/strict";
import test from "node:test";
import { requestDisplayModeWithRetry, type EsseDisplayMode } from "../web/display-mode.js";

test("display mode request retries a host that is not ready on first mount", async () => {
  let mode: EsseDisplayMode = "inline";
  let attempts = 0;
  await requestDisplayModeWithRetry({
    target: "fullscreen",
    getMode: () => mode,
    requestMode: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("host bridge is still initializing");
      mode = "fullscreen";
      return { mode };
    },
    waitForMode: async () => false,
    delaysMs: [0, 0, 0],
    sleep: async () => undefined
  });
  assert.equal(attempts, 2);
  assert.equal(mode, "fullscreen");
});

test("display mode request accepts an asynchronous host confirmation", async () => {
  let mode: EsseDisplayMode = "inline";
  await requestDisplayModeWithRetry({
    target: "fullscreen",
    getMode: () => mode,
    requestMode: async () => undefined,
    waitForMode: async () => { mode = "fullscreen"; return true; },
    delaysMs: [0]
  });
  assert.equal(mode, "fullscreen");
});
