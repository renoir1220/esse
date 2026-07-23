import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const renderer = fs.readFileSync(path.resolve(import.meta.dirname, 'renderer.tsx'), 'utf8');

describe('product window title', () => {
  it('applies the edition profile before reporting the renderer ready', () => {
    const titleAssignment = renderer.indexOf('document.title = product.displayName');
    const readyReport = renderer.indexOf('window.esse.reportReady');
    expect(titleAssignment).toBeGreaterThan(-1);
    expect(readyReport).toBeGreaterThan(titleAssignment);
  });
});
