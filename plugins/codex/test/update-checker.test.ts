import assert from "node:assert/strict";
import test from "node:test";
import { compareSemver, GitHubReleaseChecker } from "../src/update-checker.js";

function metadata(version: string, repository = "https://github.com/renoir1220/esse") {
  return JSON.stringify({ schemaVersion: 1, repository, version, tag: `v${version}` });
}

test("semantic version comparison handles stable and prerelease releases", () => {
  assert.equal(compareSemver("0.2.1", "0.2.0"), 1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0-rc.1"), 1);
  assert.throws(() => compareSemver("1.2", "1.2.0"), /Invalid semantic version/);
});

test("release checker detects a newer trusted GitHub release and caches it", async () => {
  let fetchCount = 0;
  let now = Date.parse("2026-07-19T10:00:00.000Z");
  const checker = new GitHubReleaseChecker(async (url, options) => {
    fetchCount += 1;
    assert.equal(String(url), "https://github.com/renoir1220/esse/releases/latest/download/latest.json");
    assert.equal(new Headers(options?.headers).get("user-agent"), "Esse/0.2.0");
    return new Response(metadata("0.2.1"), { status: 200 });
  }, () => now);

  const first = await checker.check("0.2.0");
  assert.deepEqual(first, {
    currentVersion: "0.2.0",
    latestVersion: "0.2.1",
    updateAvailable: true,
    checked: true,
    checkedAt: "2026-07-19T10:00:00.000Z",
    releaseUrl: "https://github.com/renoir1220/esse/releases/tag/v0.2.1",
  });
  now += 60 * 60 * 1000;
  assert.equal(await checker.check("0.2.0"), first);
  assert.equal(fetchCount, 1);
});

test("release checker fails silently and rejects untrusted metadata", async () => {
  const checker = new GitHubReleaseChecker(async () => new Response(metadata("9.9.9", "https://example.com/not-esse"), { status: 200 }), () => 0);
  assert.deepEqual(await checker.check("0.2.0"), {
    currentVersion: "0.2.0",
    updateAvailable: false,
    checked: false,
    checkedAt: "1970-01-01T00:00:00.000Z",
  });
});

test("release checker deduplicates simultaneous checks", async () => {
  let fetchCount = 0;
  let resolveResponse!: (response: Response) => void;
  const checker = new GitHubReleaseChecker(() => {
    fetchCount += 1;
    return new Promise((resolve) => { resolveResponse = resolve; });
  }, () => 0);
  const first = checker.check("0.2.0");
  const second = checker.check("0.2.0");
  resolveResponse(new Response(metadata("0.2.0"), { status: 200 }));
  assert.deepEqual(await first, await second);
  assert.equal(fetchCount, 1);
});
