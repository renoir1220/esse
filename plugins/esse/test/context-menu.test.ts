import assert from "node:assert/strict";
import test from "node:test";
import { contextMenuPoint } from "../web/context-menu.js";

test("context menu stays inside the visible viewport", () => {
  assert.deepEqual(contextMenuPoint(490, 390, 180, 140, 500, 400), { left: 312, top: 252 });
  assert.deepEqual(contextMenuPoint(-20, -10, 180, 140, 500, 400), { left: 8, top: 8 });
});
