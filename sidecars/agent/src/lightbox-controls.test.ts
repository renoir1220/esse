import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname);
const renderer = fs.readFileSync(path.join(sourceRoot, 'renderer.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(sourceRoot, 'index.css'), 'utf8');

describe('lightbox controls', () => {
  it('keeps the top close button below the Windows title-bar safe area', () => {
    expect(styles).toMatch(/\.lightbox-close\s*\{[^}]*top:\s*calc\(env\(titlebar-area-y, 0px\) \+ env\(titlebar-area-height, 0px\) \+ 14px\)/);
  });

  it('renders a separated close button after the delete action in the bottom toolbar', () => {
    const caption = renderer.match(/<div className="lightbox-caption">([\s\S]*?)<\/div>/)?.[1];
    expect(caption).toBeDefined();
    expect(caption?.indexOf('className="is-danger"')).toBeLessThan(caption?.indexOf('className="lightbox-caption-close"') ?? -1);
    expect(styles).toMatch(/\.lightbox-caption \.lightbox-caption-close\s*\{[^}]*margin-left:\s*8px/);
  });
});
