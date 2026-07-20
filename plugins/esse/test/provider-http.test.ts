import assert from "node:assert/strict";
import test from "node:test";
import { parseResponse } from "../src/providers/http.js";
import { ProviderRequestError } from "../src/types.js";

test("Provider response parsing stops oversized error bodies", async () => {
  const response = new Response(new Uint8Array(1024 * 1024 + 1), {
    status: 500,
    headers: { "content-type": "application/json" }
  });
  await assert.rejects(parseResponse(response), (error) => {
    assert(error instanceof ProviderRequestError);
    assert.match(error.message, /exceeds the allowed size/);
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
