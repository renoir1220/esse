import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMacosSigning } from './macos-signing';

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
});
