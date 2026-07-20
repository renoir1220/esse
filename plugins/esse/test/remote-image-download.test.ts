import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadRemoteImage,
  isGloballyRoutableAddress,
  resolveHostnameWithTrustedDoh,
  type PinnedImageRequester,
  type RemoteHostnameResolver
} from "../src/files/remote-image-download.js";

const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

test("configured Provider trust is limited to its exact origin", async () => {
  let directFetches = 0;
  const direct = await downloadRemoteImage({
    initialUrl: "http://127.0.0.1/generated.png",
    trustedBaseUrl: "http://127.0.0.1/v1",
    maxBytes: 1024,
    fetchImpl: async () => {
      directFetches += 1;
      return new Response(imageBytes, { status: 200 });
    },
    resolveHostname: async () => { throw new Error("same-origin request must not resolve through DoH"); },
    requestPinned: async () => { throw new Error("same-origin request must not use the pinned requester"); }
  });
  assert.deepEqual(direct, imageBytes);
  assert.equal(directFetches, 1);

  let pinnedRequests = 0;
  await downloadRemoteImage({
    initialUrl: "https://provider.example:444/generated.png",
    trustedBaseUrl: "https://provider.example/v1",
    maxBytes: 1024,
    fetchImpl: async () => { throw new Error("different ports are different origins"); },
    resolveHostname: async (hostname) => {
      assert.equal(hostname, "provider.example");
      return [{ address: "8.8.8.8", family: 4 }];
    },
    requestPinned: async (url, addresses) => {
      pinnedRequests += 1;
      assert.equal(url.port, "444");
      assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
      return response(200, imageBytes);
    }
  });
  assert.equal(pinnedRequests, 1);
});

test("cross-origin downloads pin independently resolved public addresses", async () => {
  let resolved = 0;
  let requested = 0;
  const resolver: RemoteHostnameResolver = async (hostname) => {
    resolved += 1;
    assert.equal(hostname, "cdn.provider.example");
    return [
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
      { address: "8.8.8.8", family: 4 }
    ];
  };
  const requester: PinnedImageRequester = async (url, addresses) => {
    requested += 1;
    assert.equal(url.hostname, "cdn.provider.example");
    assert.deepEqual(addresses, [
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 }
    ]);
    return response(200, imageBytes);
  };

  const bytes = await downloadRemoteImage({
    initialUrl: "https://cdn.provider.example/result.png",
    trustedBaseUrl: "https://api.provider.example/v1",
    maxBytes: 1024,
    resolveHostname: resolver,
    requestPinned: requester
  });
  assert.deepEqual(bytes, imageBytes);
  assert.equal(resolved, 1);
  assert.equal(requested, 1);
});

test("mixed public and private DNS answers fail closed before connecting", async () => {
  let requests = 0;
  await assert.rejects(downloadRemoteImage({
    initialUrl: "https://cdn.provider.example/result.png",
    trustedBaseUrl: "https://api.provider.example/v1",
    maxBytes: 1024,
    resolveHostname: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.8", family: 4 }
    ],
    requestPinned: async () => {
      requests += 1;
      return response(200, imageBytes);
    }
  }), /local or private network/);
  assert.equal(requests, 0);
});

test("every redirect is independently validated before the next request", async () => {
  let requests = 0;
  await assert.rejects(downloadRemoteImage({
    initialUrl: "https://cdn.provider.example/result.png",
    trustedBaseUrl: "https://api.provider.example/v1",
    maxBytes: 1024,
    resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }],
    requestPinned: async () => {
      requests += 1;
      return response(302, new Uint8Array(), { location: "https://127.0.0.1/private.png" });
    }
  }), /local or private network/);
  assert.equal(requests, 1);
});

test("trusted DoH answers replace OS Fake-IP results", async () => {
  const queries: string[] = [];
  const addresses = await resolveHostnameWithTrustedDoh("cdn.provider.example", async (input) => {
    const url = new URL(String(input));
    queries.push(`${url.hostname}:${url.searchParams.get("type")}`);
    const type = Number(url.searchParams.get("type"));
    return Response.json({
      Status: 0,
      Answer: type === 1
        ? [{ name: "cdn.provider.example.", type: 1, data: "8.8.4.4" }]
        : [{ name: "cdn.provider.example.", type: 28, data: "2001:4860:4860::8844" }]
    });
  });
  assert.deepEqual(addresses, [
    { address: "8.8.4.4", family: 4 },
    { address: "2001:4860:4860::8844", family: 6 }
  ]);
  assert.deepEqual(queries.sort(), ["cloudflare-dns.com:1", "cloudflare-dns.com:28"]);
});

test("only globally routable unicast addresses pass remote validation", () => {
  assert.equal(isGloballyRoutableAddress("8.8.8.8"), true);
  assert.equal(isGloballyRoutableAddress("2001:4860:4860::8888"), true);
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1"
  ]) assert.equal(isGloballyRoutableAddress(address), false, address);
});

function response(status: number, bytes: Uint8Array, headers?: HeadersInit): {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
} {
  return { status, headers: new Headers(headers), bytes };
}
