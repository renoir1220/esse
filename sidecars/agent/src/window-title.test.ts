import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatWindowTitle } from './window-title';

const renderer = fs.readFileSync(path.resolve(import.meta.dirname, 'renderer.tsx'), 'utf8');

describe('product window title', () => {
  it('includes the edition profile and installed version', () => {
    expect(formatWindowTitle('Esse Community', '0.3.3-alpha.1')).toBe('Esse Community 0.3.3-alpha.1');
    expect(formatWindowTitle('Esse', '1.0.2')).toBe('Esse 1.0.2');
  });

  it('applies the versioned title before reporting the renderer ready', () => {
    const titleAssignment = renderer.indexOf('document.title = windowTitle');
    const readyReport = renderer.indexOf('window.esse.reportReady');
    expect(titleAssignment).toBeGreaterThan(-1);
    expect(readyReport).toBeGreaterThan(titleAssignment);
  });
});
