import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsStore } from "../src/storage/settings-store.js";
import { createSecretStore, MemorySecretStore } from "../src/storage/secret-store.js";
import { CODEX_GENERATION_OFFERING_ID } from "../src/types.js";

const offering = {
  id: "offer-default",
  canonicalModelId: "gpt-image-2",
  providerModelId: "gpt-image-2",
  displayName: "GPT-Image 2",
  price: { mode: "per_request" as const, currency: "CNY", amount: 0.035 },
  supportsTextToImage: true,
  supportsImageToImage: true,
  sizes: [],
  qualities: []
};

test("provider keys stay out of settings JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-settings-"));
  try {
    const secrets = new MemorySecretStore();
    const settingsPath = path.join(root, "settings.json");
    const store = new SettingsStore(settingsPath, secrets);
    const profile = await store.saveProvider({
      displayName: "AIBuff",
      tierName: "default",
      baseUrl: "https://aibuff.cc/",
      adapterId: "openai-images",
      concurrency: 3,
      apiKey: "secret-test-key",
      offerings: [offering]
    });
    assert.equal(profile.hasApiKey, true);
    assert.equal(await store.getApiKey(profile.id), "secret-test-key");
    const raw = await readFile(settingsPath, "utf8");
    assert(!raw.includes("secret-test-key"));
    assert.equal(JSON.parse(raw).providers[0].baseUrl, "https://aibuff.cc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex generation can be selected as the default without a Provider profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-codex-default-"));
  try {
    const store = new SettingsStore(path.join(root, "settings.json"), new MemorySecretStore());
    await store.setDefaultOffering(CODEX_GENERATION_OFFERING_ID);
    assert.equal((await store.load()).defaultOfferingId, CODEX_GENERATION_OFFERING_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows secure storage round-trips through current-user DPAPI", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "esse-dpapi-"));
  try {
    const secrets = createSecretStore(root, "win32");
    await secrets.set("profile-1", "dpapi-secret-value");
    assert.equal(await secrets.get("profile-1"), "dpapi-secret-value");
    await secrets.delete("profile-1");
    assert.equal(await secrets.get("profile-1"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
