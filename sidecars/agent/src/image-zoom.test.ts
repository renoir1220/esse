import { describe, expect, it } from 'vitest';
import { initialImageZoom, zoomImageAtPoint } from './image-zoom';

describe('image zoom', () => {
  it('keeps the image point under the mouse stationary', () => {
    const zoomed = zoomImageAtPoint(initialImageZoom, -120, 100, 50);
    expect(zoomed.scale).toBeGreaterThan(1);
    expect((100 - zoomed.x) / zoomed.scale).toBeCloseTo(100);
    expect((50 - zoomed.y) / zoomed.scale).toBeCloseTo(50);
  });

  it('is bounded and returns to the fitted image', () => {
    const maximum = zoomImageAtPoint(initialImageZoom, -100_000, 0, 0);
    expect(maximum.scale).toBe(8);
    expect(zoomImageAtPoint(maximum, 100_000, 40, 30)).toEqual(initialImageZoom);
  });
});
