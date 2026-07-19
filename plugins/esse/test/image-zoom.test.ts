import assert from "node:assert/strict";
import test from "node:test";
import { initialImageZoom, zoomImageAtPoint } from "../web/image-zoom.js";

test("wheel zoom keeps the image point under the mouse stationary", () => {
  const zoomed = zoomImageAtPoint(initialImageZoom, -120, 100, 50);
  assert(zoomed.scale > 1);
  assert(Math.abs((100 - zoomed.x) / zoomed.scale - 100) < 0.000001);
  assert(Math.abs((50 - zoomed.y) / zoomed.scale - 50) < 0.000001);
});

test("wheel zoom is bounded and returns to the fitted image", () => {
  const maximum = zoomImageAtPoint(initialImageZoom, -100_000, 0, 0);
  assert.equal(maximum.scale, 8);
  assert.deepEqual(zoomImageAtPoint(maximum, 100_000, 40, 30), initialImageZoom);
});
