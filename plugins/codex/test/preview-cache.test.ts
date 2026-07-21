import assert from "node:assert/strict";
import test from "node:test";
import { DataUrlLruCache, jobFileSignature } from "../web/preview-cache.js";

test("preview data URL cache evicts least-recently-used entries within its budget", () => {
  const cache = new DataUrlLruCache(10);
  cache.set("a", "1234");
  cache.set("b", "5678");
  assert.equal(cache.get("a"), "1234");
  cache.set("c", "abcd");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "1234");
  assert.equal(cache.get("c"), "abcd");
  assert.equal(cache.chars, 8);
});

test("preview data URL cache skips a single value larger than its total budget", () => {
  const cache = new DataUrlLruCache(4);
  cache.set("large", "12345");
  assert.equal(cache.size, 0);
  assert.equal(cache.chars, 0);
});

test("managed preview signatures invalidate an overwritten path after a new attempt finishes", () => {
  const filePath = "C:\\images\\batch\\image-1.png";
  const first = jobFileSignature({ attempt: 1, status: "succeeded", createdAt: "2026-07-19T01:00:00.000Z", finishedAt: "2026-07-19T01:01:00.000Z" }, filePath);
  const overwritten = jobFileSignature({ attempt: 2, status: "succeeded", createdAt: "2026-07-19T01:00:00.000Z", finishedAt: "2026-07-19T01:03:00.000Z" }, filePath);
  assert.notEqual(first, overwritten);
  assert.equal(first, jobFileSignature({ attempt: 1, status: "succeeded", createdAt: "2026-07-19T01:00:00.000Z", finishedAt: "2026-07-19T01:01:00.000Z" }, filePath));
});
