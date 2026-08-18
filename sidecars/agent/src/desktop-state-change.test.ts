import { describe, expect, it } from 'vitest';
import { applyDesktopStateChange } from './desktop-state-change';
import type { BatchSnapshot, DesktopState, SavedImage } from './types';

describe('desktop state changes', () => {
  it('updates one batch and only the images named by that change', () => {
    const first = batch('batch-first', '2026-08-18T01:00:00.000Z');
    const second = batch('batch-second', '2026-08-18T02:00:00.000Z');
    const oldImage = image('image-old');
    const unrelatedImage = image('image-unrelated');
    const state = { ...desktopState([second, first], [oldImage, unrelatedImage]), editionState: 'preserved' };
    const updated = { ...first, updatedAt: '2026-08-18T03:00:00.000Z', running: 1, queued: 0, status: 'running' as const };
    const nextImage = image('image-next');

    const next = applyDesktopStateChange(state, {
      type: 'batch-upsert',
      batch: updated,
      images: [nextImage],
      removedImageIds: [oldImage.id],
      activeBatchId: first.id,
    });

    expect(next.batches.find((candidate) => candidate.id === first.id)).toEqual(updated);
    expect(next.batches.find((candidate) => candidate.id === second.id)).toBe(second);
    expect(next.images.map((candidate) => candidate.id).sort()).toEqual([nextImage.id, unrelatedImage.id].sort());
    expect(next.providers).toBe(state.providers);
    expect(next.offerings).toBe(state.offerings);
    expect(next.editionState).toBe('preserved');
  });
});

function desktopState(batches: BatchSnapshot[], images: SavedImage[]): DesktopState {
  return {
    configured: true,
    providers: [],
    offerings: [],
    images,
    batches,
    activeBatchId: batches[0]?.id,
    mcp: { available: true, endpoint: 'http://127.0.0.1/mcp' },
    platform: 'test',
    secureStorage: 'test',
  };
}

function batch(id: string, createdAt: string): BatchSnapshot {
  return {
    id,
    appendKeys: {},
    modificationKeys: {},
    mergeKeys: {},
    title: id,
    prompt: id,
    offering: {
      id: 'offering', canonicalModelId: 'offering', providerModelId: 'offering', displayName: 'Offering',
      providerName: 'Provider', providerType: 'openai-images', tierName: 'Default', concurrency: 3,
      priceMicros: 0, currency: 'CNY', price: { mode: 'per_request', currency: 'CNY', amount: 0 }, configured: true,
      sizes: [], supportsTextToImage: true, supportsImageToImage: true,
    },
    jobs: [],
    createdAt,
    updatedAt: createdAt,
    status: 'queued',
    total: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    estimatedCostMicros: 0,
  };
}

function image(id: string): SavedImage {
  return {
    id,
    requestId: id,
    mediaUrl: `esse-media://local/${id}.png`,
    thumbnailUrl: `esse-media://thumbnail/${id}.png`,
    fileName: `${id}.png`,
    prompt: id,
    model: 'test',
    createdAt: '2026-08-18T00:00:00.000Z',
  };
}
