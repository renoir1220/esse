import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesPath = new URL("../web/styles.css", import.meta.url);
const workbenchPath = new URL("../web/main.tsx", import.meta.url);

test("selectable thumbnails keep the default cursor and select only on double click", async () => {
  const [styles, workbench] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(workbenchPath, "utf8")
  ]);

  assert.match(styles, /\.image-button\.is-attachable:enabled\s*\{\s*cursor:\s*default;\s*\}/);
  assert.doesNotMatch(styles, /\.image-button\.is-attachable:enabled[^}]*cursor:\s*copy/);
  assert.match(workbench, /onDoubleClick=\{attachOnDoubleClick\}/);
  assert.match(workbench, /props\.onSelect\(\);/);
});

test("thumbnail names overlay square image frames", async () => {
  const styles = await readFile(stylesPath, "utf8");

  assert.match(styles, /\.job-card\s*\{[^}]*border-radius:\s*0;/);
  assert.match(styles, /\.card-copy\s*\{[^}]*position:\s*absolute;[^}]*left:\s*6px;[^}]*bottom:\s*6px;/);
  assert.match(styles, /\.card-copy strong\s*\{[^}]*border-radius:\s*999px;[^}]*background:\s*var\(--thumbnail-control-bg\);/);
});

test("task reference images use a compact thumbnail grid with filename-only captions", async () => {
  const [styles, workbench] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(workbenchPath, "utf8")
  ]);

  assert.match(styles, /\.task-reference-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*76px\);/);
  assert.match(styles, /\.task-reference-image\s*\{[^}]*width:\s*76px;[^}]*height:\s*76px;/);
  assert.match(workbench, /<figcaption>\{name\}<\/figcaption>/);
  assert.doesNotMatch(workbench, /<b>参考图 \{index \+ 1\}<\/b>/);
  assert.doesNotMatch(workbench, /<code title=\{filePath\}>\{filePath\}<\/code>/);
});
