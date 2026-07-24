import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTransportError, parseResponse, providerError } from "../src/providers/http.js";
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

test("transport errors are attributed to the Esse-side request path", () => {
  const error = normalizeTransportError(new Error("connection dropped"));
  assert.equal(error.details.origin, "esse");
});
