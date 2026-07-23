import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(import.meta.dirname, 'index.css'), 'utf8');

describe('desktop layout height', () => {
  it('subtracts the Windows title-bar overlay from the batch workspace height', () => {
    expect(css).toMatch(/\.batch-page\s*\{[^}]*min-height:\s*calc\(100vh - 94px - env\(titlebar-area-height, 0px\)\)/);
  });
});
