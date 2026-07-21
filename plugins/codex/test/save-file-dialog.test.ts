import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveFileAs } from "../src/files/save-file-dialog.js";

test("native save workflow copies the selected local image and keeps its extension", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-save-"));
  try {
    const source = path.join(root, "source.png");
    const selectedWithoutExtension = path.join(root, "chosen-name");
    await writeFile(source, Buffer.from("local-image"));
    const saved = await saveFileAs(source, "图1.png", async (suggestedName) => {
      assert.equal(suggestedName, "图1.png");
      return selectedWithoutExtension;
    });
    assert.equal(saved, `${selectedWithoutExtension}.png`);
    assert.equal((await readFile(saved!)).toString(), "local-image");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
