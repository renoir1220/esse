import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('bounded thumbnail rendering', () => {
  it('loads cached previews only near the viewport and unloads them offscreen', async () => {
    const source = await readFile(new URL('./renderer.tsx', import.meta.url), 'utf8');

    expect(source).toContain("const THUMBNAIL_ROOT_MARGIN = '800px 0px'");
    expect(source).toContain('const deferredImageListeners = new Map');
    expect(source).toMatch(/new IntersectionObserver\([\s\S]*deferredImageListeners\.get\([\s\S]*rootMargin: THUMBNAIL_ROOT_MARGIN/);
    expect(source).toContain('return observeDeferredImage(element, setNearViewport)');
    expect(source).toContain('src={nearViewport ? source : undefined}');
    expect(source).toContain('loading="lazy"');
    expect(source).toContain('decoding="async"');
    expect(source).toContain('previewSrc: image.thumbnailUrl || image.mediaUrl');
  });

  it('uses originals directly only for the explicit full-image viewer', async () => {
    const source = await readFile(new URL('./renderer.tsx', import.meta.url), 'utf8');
    const directOriginals = source.match(/<img src=\{image\.mediaUrl\}/g) ?? [];

    expect(directOriginals).toHaveLength(1);
    expect(source).toMatch(/function ImageViewer[\s\S]*<img src=\{image\.mediaUrl\}/);
    expect(source).toMatch(/previews\.slice\(0, 3\)[\s\S]*<DeferredImage/);
  });

  it('skips paint and layout work for offscreen gallery and batch cards', async () => {
    const styles = await readFile(new URL('./index.css', import.meta.url), 'utf8');

    expect(styles).toMatch(/\.image-card\s*\{[^}]*content-visibility:\s*auto/);
    expect(styles).toMatch(/\.batch-library-card\s*\{[^}]*content-visibility:\s*auto/);
  });
});
