import assert from "node:assert/strict";
import test from "node:test";
import { folderOpenInvocation } from "../src/files/open-folder.js";

test("batch folders use the native Windows and macOS open commands without a shell", () => {
  assert.deepEqual(folderOpenInvocation("C:\\Images\\batch-1", "win32"), {
    command: "explorer.exe",
    args: ["C:\\Images\\batch-1"]
  });
  assert.deepEqual(folderOpenInvocation("/Users/demo/Pictures/batch-1", "darwin"), {
    command: "/usr/bin/open",
    args: ["/Users/demo/Pictures/batch-1"]
  });
  assert.throws(() => folderOpenInvocation("/tmp/batch-1", "linux"), /not supported/);
});
