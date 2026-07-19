import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the lightbox requires direct local media and reports failures instead of requesting a 2400px fallback", async () => {
  const workbench = await readFile(new URL("../web/main.tsx", import.meta.url), "utf8");
  assert.match(workbench, /ui_get_direct_image_url/);
  assert.match(workbench, /原图直读失败/);
  assert.doesNotMatch(workbench, /loadFallbackPreview/);
  assert.doesNotMatch(workbench, /ui_get_image_preview[\s\S]{0,160}full:\s*true/);
});
