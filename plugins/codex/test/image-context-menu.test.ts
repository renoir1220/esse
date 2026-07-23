import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workbenchPath = new URL("../web/main.tsx", import.meta.url);

test("thumbnail context menu exposes selection, clipboard copy, and exact deletion", async () => {
  const workbench = await readFile(workbenchPath, "utf8");
  assert.match(workbench, /onContextMenu=\{\(event\) => openImageContextMenu\(event, asset, "thumbnail"\)\}/);
  assert.match(workbench, />\{props\.selected \? "取消选择" : "选择"\}</);
  assert.match(workbench, />复制图片</);
  assert.match(workbench, />复制图片 ID</);
  assert.match(workbench, /bridge\.callTool\("ui_copy_image_to_clipboard", \{ batchId: batch\.id, jobId: asset\.id \}\)/);
  assert.match(workbench, /bridge\.callTool\("ui_copy_image_id_to_clipboard", \{ batchId: batch\.id, jobId: asset\.id \}\)/);
  assert.match(workbench, /bridge\.callTool\("ui_delete_esse_images", \{ batchId: batch\.id, imageIds: \[asset\.id\] \}\)/);
});

test("large image context menu exposes clipboard copy without deletion", async () => {
  const workbench = await readFile(workbenchPath, "utf8");
  assert.match(workbench, /openImageContextMenu\(event, previewAsset, "lightbox"\)/);
  assert.match(workbench, /contextMenu\.scope === "thumbnail" \? \(\) => void deleteImage/);
});

test("batch title exposes an adjacent copy-reference control", async () => {
  const workbench = await readFile(workbenchPath, "utf8");
  assert.match(workbench, /className="batch-reference-copy"/);
  assert.match(workbench, /aria-label="复制批次名称和 ID"/);
  assert.match(workbench, /bridge\.callTool\("ui_copy_batch_reference_to_clipboard", \{ batchId: activeBatch\.id \}\)/);
});
