import { describe, expect, it } from 'vitest';
import { batchReferenceText, imageIdReferenceText } from './reference-text';

describe('copyable Esse references', () => {
  it('names the batch and preserves its exact ID', () => {
    expect(batchReferenceText('春季海报', 'batch-123')).toBe('批次名称：春季海报\nbatchId: batch-123');
  });

  it('preserves the exact image ID', () => {
    expect(imageIdReferenceText('image-456')).toBe('imageId: image-456');
  });
});
