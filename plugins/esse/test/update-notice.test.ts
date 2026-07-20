import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workbench checks once and renders a subtle header update link", async () => {
  const [workbench, styles] = await Promise.all([
    readFile(new URL("../web/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(workbench, /bridge\.callTool\("ui_check_for_updates", \{\}\)/);
  assert.match(workbench, /updateStatus\?\.updateAvailable/);
  assert.match(workbench, /className="header-update-link"/);
  assert.match(workbench, />有新版本<\/a>/);
  assert.match(workbench, /href=\{updateStatus\.releaseUrl\}/);
  assert.match(workbench, /target="_blank"\s+rel="noopener noreferrer"/);
  assert.doesNotMatch(workbench, /update-notice/);
  assert.doesNotMatch(workbench, /setDismissedUpdateVersion/);
  assert.match(styles, /\.header-update-link\s*\{/);
  assert.doesNotMatch(styles, /\.update-notice/);
});
