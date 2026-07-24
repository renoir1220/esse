import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import product from '../product.json';

describe('desktop product profile', () => {
  it('keeps package metadata and product identity aligned', async () => {
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as { productName: string; version: string };
    expect(packageJson.productName).toBe(product.displayName);
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
  });

  it('uses non-overlapping installer, runtime, and release identities', () => {
    expect(product.windowsSquirrelAppId).not.toBe(product.userDataDirectory);
    expect(product.macosAppBundleId).toMatch(/^com\.renoir\.esse\./);
    expect(product.releasePrefix).toMatch(/^esse-/);
  });

  it('declares an explicit error-attribution privacy policy', () => {
    expect(typeof product.errorAttribution.showProviderIdentity).toBe('boolean');
    expect(product.errorAttribution.redactProviderTerms).toEqual(expect.any(Array));
  });
});
