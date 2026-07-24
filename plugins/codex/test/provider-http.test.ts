import assert from "node:assert/strict";
import test from "node:test";
import { extractImageResult, IMAGE_REQUEST_TIMEOUT_MS, normalizeTransportError, parseResponse, providerError } from "../src/providers/http.js";
import { ProviderRequestError } from "../src/types.js";

test("Provider response parsing stops oversized error bodies", async () => {
  const response = new Response(new Uint8Array(1024 * 1024 + 1), {
    status: 500,
    headers: { "content-type": "application/json" }
  });
  await assert.rejects(parseResponse(response), (error) => {
    assert(error instanceof ProviderRequestError);
    assert.match(error.message, /exceeds the allowed size/);
    assert.equal(error.details.origin, "esse");
    return true;
  });
});

test("Provider response parsing rejects an oversized declared body before reading it", async () => {
  const response = new Response("{}", {
    status: 200,
    headers: { "content-length": String(82 * 1024 * 1024 + 1) }
  });
  await assert.rejects(parseResponse(response), /exceeds the allowed size/);
});

test("Provider errors preserve upstream text without an Esse-owned prefix", () => {
  const error = providerError(new Response("{}", { status: 429 }), {
    error: { message: "low balance queue wait timeout", code: "busy" },
    request_id: "request-1"
  });
  assert.equal(error.message, "low balance queue wait timeout");
  assert.equal(error.details.origin, "upstream");
  assert.equal(error.details.requestId, "request-1");
});

test("transport errors are not attributed conclusively to Esse or the upstream service", () => {
  const error = normalizeTransportError(Object.assign(new Error("connection dropped"), { code: "ETIMEDOUT" }));
  assert.equal(error.details.origin, "transport");
  assert.match(error.message, /ETIMEDOUT/);
});

test("image requests allow queue-heavy models up to fifteen minutes", () => {
  assert.equal(IMAGE_REQUEST_TIMEOUT_MS, 900_000);
  const error = normalizeTransportError(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  assert.equal(error.details.origin, "transport");
  assert.match(error.message, /15 分钟内未返回/);
});

test("Provider image parsing accepts data-image URLs returned by compatible relays", () => {
  const result = extractImageResult({ data: [{ url: "data:image/webp;base64,AAECAw==" }] });
  assert.deepEqual(result, { b64Json: "AAECAw==", mimeType: "image/webp", outputUrl: undefined });
});

test("Provider image parsing prefers base64 over a non-HTTP relay URL", () => {
  const result = extractImageResult({ data: [{ url: "/generated/image.png", b64_json: "AAECAw==" }] });
  assert.deepEqual(result, { b64Json: "AAECAw==", mimeType: "image/png", outputUrl: undefined });
});
