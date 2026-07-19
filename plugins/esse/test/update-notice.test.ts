import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workbench checks once and only renders a trusted newer release notice", async () => {
  const workbench = await readFile(new URL("../web/main.tsx", import.meta.url), "utf8");
  assert.match(workbench, /bridge\.callTool\("ui_check_for_updates", \{\}\)/);
  assert.match(workbench, /updateStatus\?\.updateAvailable/);
  assert.match(workbench, /href=\{updateStatus\.releaseUrl\}/);
  assert.match(workbench, /target="_blank" rel="noopener noreferrer"/);
  assert.match(workbench, /setDismissedUpdateVersion\(updateStatus\.latestVersion\)/);
});
