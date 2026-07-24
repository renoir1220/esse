import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMacosSigning, resignAdhocMacosBundles } from './macos-signing';

describe('resolveMacosSigning', () => {
  it('fully ad-hoc signs builds when Developer ID credentials are absent', () => {
    expect(resolveMacosSigning({})).toEqual({
      packager: {
        osxSign: {
          identity: '-',
          identityValidation: false,
        },
      },
    });
  });

  it('configures Developer ID signing and API-key notarization', () => {
    expect(resolveMacosSigning({
      MACOS_SIGN_IDENTITY: 'Developer ID Application: Example (TEAM123)',
      MACOS_NOTARY_API_KEY_PATH: 'secrets/AuthKey_TEST.p8',
      MACOS_NOTARY_API_KEY_ID: 'KEY123',
      MACOS_NOTARY_API_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
    })).toEqual({
      identity: 'Developer ID Application: Example (TEAM123)',
      packager: {
        osxSign: { identity: 'Developer ID Application: Example (TEAM123)' },
        osxNotarize: {
          appleApiKey: path.resolve('secrets/AuthKey_TEST.p8'),
          appleApiKeyId: 'KEY123',
          appleApiIssuer: '00000000-0000-0000-0000-000000000000',
        },
      },
    });
  });

  it('rejects incomplete or unsigned notarization configuration', () => {
    expect(() => resolveMacosSigning({ MACOS_NOTARY_API_KEY_ID: 'KEY123' })).toThrow(/requires API key path/);
    expect(() => resolveMacosSigning({
      MACOS_NOTARY_API_KEY_PATH: 'AuthKey.p8',
      MACOS_NOTARY_API_KEY_ID: 'KEY123',
      MACOS_NOTARY_API_ISSUER_ID: 'issuer',
    })).toThrow(/requires MACOS_SIGN_IDENTITY/);
  });

  it('re-signs a completed unsigned macOS bundle as one ad-hoc unit', () => {
    const calls: unknown[][] = [];
    resignAdhocMacosBundles({
      platform: 'darwin',
      outputPaths: ['/tmp/Esse Community-darwin-arm64', '/tmp/already.app'],
    }, 'Esse Community', undefined, (...args) => calls.push(args));
    expect(calls).toEqual([
      ['/usr/bin/codesign', ['--force', '--deep', '--sign', '-', path.join('/tmp/Esse Community-darwin-arm64', 'Esse Community.app')], { stdio: 'inherit' }],
      ['/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '/tmp/already.app'], { stdio: 'inherit' }],
    ]);
  });

  it('does not replace Developer ID signatures or touch non-macOS packages', () => {
    const calls: unknown[][] = [];
    const run = (...args: unknown[]) => calls.push(args);
    resignAdhocMacosBundles({ platform: 'darwin', outputPaths: ['/tmp/app'] }, 'Esse Community', 'Developer ID Application: Example', run);
    resignAdhocMacosBundles({ platform: 'win32', outputPaths: ['C:\\tmp\\app'] }, 'Esse Community', undefined, run);
    expect(calls).toEqual([]);
  });
});
