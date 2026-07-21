import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BatchStore } from './batch-store';
import type { BatchRecord } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('BatchStore', () => {
  it('quarantines corrupt records without hiding healthy batches', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'esse-batches-'));
    temporaryDirectories.push(directory);
    const store = new BatchStore(directory);
    const valid = sampleBatch();
    await store.save(valid);
    await writeFile(path.join(directory, 'broken.json'), '{ broken', 'utf8');
    await writeFile(path.join(directory, 'wrong-shape.json'), JSON.stringify({ id: 'not-a-batch' }), 'utf8');

    expect((await store.loadAll()).map((batch) => batch.id)).toEqual([valid.id]);
    expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toEqual([`${valid.id}.json`]);
    const quarantined = await readdir(path.join(directory, '.quarantine'));
    expect(quarantined).toHaveLength(2);
    expect(quarantined.some((name) => name.endsWith('broken.json'))).toBe(true);
    expect(quarantined.some((name) => name.endsWith('wrong-shape.json'))).toBe(true);
  });
});

function sampleBatch(): BatchRecord {
  const now = new Date().toISOString();
  return {
    id: '11111111-1111-4111-8111-111111111111',
    appendKeys: {},
    modificationKeys: {},
    mergeKeys: {},
    title: 'healthy',
    prompt: 'test',
    offering: {
      id: 'offer-default',
      canonicalModelId: 'image-model',
      providerModelId: 'image-model',
      displayName: 'Image model',
      providerName: 'Esse',
      providerType: 'tuzi-json-images',
      tierName: '默认',
      concurrency: 3,
      priceMicros: 100_000,
      currency: 'CNY',
      price: { mode: 'per_request', currency: 'CNY', amount: 0.1 },
      configured: true,
      sizes: ['1024x1024'],
      supportsTextToImage: true,
      supportsImageToImage: true,
    },
    jobs: [],
    createdAt: now,
    updatedAt: now,
  };
}
