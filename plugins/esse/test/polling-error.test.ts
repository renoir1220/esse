import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { errorMessage, resolveBackgroundPollingError, TRANSPORT_CLOSED_NOTICE } from "../web/polling-error.js";

test("a closed MCP transport stops polling and produces only one notice", () => {
  assert.deepEqual(resolveBackgroundPollingError(new Error("tool call failed: Transport closed")), {
    stop: true,
    notice: TRANSPORT_CLOSED_NOTICE,
  });
  assert.deepEqual(resolveBackgroundPollingError({ message: "Transport is closed" }, true), {
    stop: true,
    notice: undefined,
  });
});

test("ordinary tool failures remain retryable and preserve their message", () => {
  const error = new Error("Provider temporarily unavailable");
  assert.deepEqual(resolveBackgroundPollingError(error), { stop: false, notice: "Provider temporarily unavailable" });
  assert.equal(errorMessage(error), "Provider temporarily unavailable");
  assert.equal(errorMessage(undefined), "本地插件操作失败。");
});

test("workbench stops both recurring pollers after the transport closes", async () => {
  const workbench = await readFile(new URL("../web/main.tsx", import.meta.url), "utf8");
  assert.match(workbench, /\.catch\(handleBackgroundPollingError\)/);
  assert.equal([...workbench.matchAll(/handleBackgroundPollingError\(error\)\) canceled = true/g)].length, 2);
  assert.ok([...workbench.matchAll(/transportClosedRef\.current/g)].length >= 6);
});
