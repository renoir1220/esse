import { describe, expect, it } from 'vitest';
import { galleryAssets } from './gallery-assets';
import type { OfferingSummary, SavedImage } from './types';

describe('gallery assets', () => {
  it('renders current and backup assets without duplicating a failed source that is already preserved', () => {
    const offering = sampleOffering();
    const images = new Map<string, SavedImage>([
      sampleImage('current'),
      sampleImage('backup'),
      sampleImage('failed-source'),
    ].map((image) => [image.id, image] as const));
    const assets = galleryAssets({
      id: 'batch', appendKeys: {}, modificationKeys: {}, mergeKeys: {}, title: 'Batch', prompt: 'Prompt', offering,
      jobs: [{
        id: 'job-1', index: 0, name: '图1', prompt: 'current prompt', requestKey: 'request-one', operation: 'generate', status: 'succeeded', progress: 100, attempt: 1, retryable: false, chargeState: 'charged', referenceImageIds: [], outputImageId: 'current', backups: [{ id: 'backup-record', name: '图1-1', imageId: 'backup', prompt: 'old prompt', createdAt: '2026-01-01T00:00:00.000Z' }], createdAt: '2026-01-01T00:00:00.000Z', callHistory: [],
      }, {
        id: 'job-2', index: 1, name: '图2', prompt: 'failed edit', requestKey: 'request-two', operation: 'modify', status: 'failed', progress: 100, attempt: 1, retryable: false, chargeState: 'unknown', referenceImageIds: ['failed-source'], backups: [{ id: 'failed-backup', name: '图2-1', imageId: 'failed-source', prompt: 'source prompt', createdAt: '2026-01-01T00:00:00.000Z' }], createdAt: '2026-01-01T00:00:00.000Z', callHistory: [],
      }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'partial', total: 2, queued: 0, running: 0, succeeded: 1, failed: 1, canceled: 0, estimatedCostMicros: 200_000,
    }, images);

    expect(assets.map((asset) => [asset.name, asset.kind, asset.imageId])).toEqual([
      ['图1', 'job', 'current'],
      ['图1-1', 'backup', 'backup'],
      ['图2', 'job', undefined],
      ['图2-1', 'backup', 'failed-source'],
    ]);
  });
});

function sampleOffering(): OfferingSummary {
  return { id: 'model', canonicalModelId: 'model', providerModelId: 'model', displayName: 'Model', providerName: 'Provider', providerType: 'tuzi-json-images', tierName: '默认', concurrency: 3, priceMicros: 100_000, currency: 'CNY', price: { mode: 'per_request', currency: 'CNY', amount: 0.1 }, configured: true, sizes: ['1024x1024'], supportsTextToImage: true, supportsImageToImage: true };
}

function sampleImage(id: string): SavedImage {
  return { id, requestId: `request-${id}`, mediaUrl: `esse-media://local/${id}.png`, fileName: `${id}.png`, prompt: id, model: 'model', createdAt: '2026-01-01T00:00:00.000Z' };
}
