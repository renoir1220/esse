const LATEST_METADATA_URL = "https://github.com/renoir1220/esse/releases/latest/download/latest.json";
const RELEASES_URL = "https://github.com/renoir1220/esse/releases";
const EXPECTED_REPOSITORY = "https://github.com/renoir1220/esse";
const SUCCESS_CACHE_MS = 6 * 60 * 60 * 1000;
const FAILURE_CACHE_MS = 15 * 60 * 1000;
const MAX_METADATA_CHARS = 64 * 1024;

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checked: boolean;
  checkedAt: string;
  releaseUrl?: string;
}

export interface UpdateCheckerLike {
  check(currentVersion: string): Promise<UpdateCheckResult>;
}

export class GitHubReleaseChecker implements UpdateCheckerLike {
  private cached: { currentVersion: string; expiresAt: number; result: UpdateCheckResult } | undefined;
  private pending: Promise<UpdateCheckResult> | undefined;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async check(currentVersion: string): Promise<UpdateCheckResult> {
    const now = this.now();
    if (this.cached?.currentVersion === currentVersion && this.cached.expiresAt > now) return this.cached.result;
    if (this.pending) return this.pending;
    const pending = this.load(currentVersion, now).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private async load(currentVersion: string, checkedAtMs: number): Promise<UpdateCheckResult> {
    const checkedAt = new Date(checkedAtMs).toISOString();
    try {
      const response = await this.fetchImpl(LATEST_METADATA_URL, {
        headers: { Accept: "application/json", "User-Agent": `Esse/${currentVersion}` },
        redirect: "follow",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_METADATA_CHARS) throw new Error("Release metadata is unexpectedly large.");
      const metadata = parseReleaseMetadata(text);
      const result: UpdateCheckResult = {
        currentVersion,
        latestVersion: metadata.version,
        updateAvailable: compareSemver(metadata.version, currentVersion) > 0,
        checked: true,
        checkedAt,
        releaseUrl: `${RELEASES_URL}/tag/${encodeURIComponent(metadata.tag)}`,
      };
      this.cached = { currentVersion, expiresAt: checkedAtMs + SUCCESS_CACHE_MS, result };
      return result;
    } catch {
      const result: UpdateCheckResult = { currentVersion, updateAvailable: false, checked: false, checkedAt };
      this.cached = { currentVersion, expiresAt: checkedAtMs + FAILURE_CACHE_MS, result };
      return result;
    }
  }
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]! ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumber = /^\d+$/u.test(aPart) ? Number(aPart) : undefined;
    const bNumber = /^\d+$/u.test(bPart) ? Number(bPart) : undefined;
    if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber ? 1 : -1;
    if (aNumber !== undefined) return -1;
    if (bNumber !== undefined) return 1;
    return aPart > bPart ? 1 : -1;
  }
  return 0;
}

function parseReleaseMetadata(value: string): { version: string; tag: string } {
  const parsed = JSON.parse(value) as { schemaVersion?: unknown; repository?: unknown; version?: unknown; tag?: unknown };
  if (parsed.schemaVersion !== 1 || parsed.repository !== EXPECTED_REPOSITORY) throw new Error("Unexpected release metadata source.");
  if (typeof parsed.version !== "string" || typeof parsed.tag !== "string") throw new Error("Release metadata has no version.");
  parseSemver(parsed.version);
  if (parsed.tag !== `v${parsed.version}`) throw new Error("Release tag does not match its version.");
  return { version: parsed.version, tag: parsed.tag };
}

function parseSemver(value: string): { core: [number, number, number]; prerelease: string[] } {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error(`Invalid semantic version: ${value}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") || [],
  };
}
