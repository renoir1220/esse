import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';

type PackagerConfig = NonNullable<ForgeConfig['packagerConfig']>;

export interface ResolvedMacosSigning {
  identity?: string;
  packager: Pick<PackagerConfig, 'osxNotarize' | 'osxSign'>;
}

export function resolveMacosSigning(env: NodeJS.ProcessEnv = process.env): ResolvedMacosSigning {
  const identity = nonEmpty(env.MACOS_SIGN_IDENTITY);
  const appleApiKey = nonEmpty(env.MACOS_NOTARY_API_KEY_PATH);
  const appleApiKeyId = nonEmpty(env.MACOS_NOTARY_API_KEY_ID);
  const appleApiIssuer = nonEmpty(env.MACOS_NOTARY_API_ISSUER_ID);
  const notaryValues = [appleApiKey, appleApiKeyId, appleApiIssuer];
  const hasNotaryValue = notaryValues.some(Boolean);
  const hasCompleteNotaryConfig = notaryValues.every(Boolean);

  if (hasNotaryValue && !hasCompleteNotaryConfig) {
    throw new Error('macOS notarization requires API key path, key ID, and issuer ID.');
  }
  if (hasNotaryValue && !identity) {
    throw new Error('macOS notarization requires MACOS_SIGN_IDENTITY.');
  }
  if (!identity) {
    return {
      packager: {
        // FusesPlugin changes the Electron executable before Packager's signing
        // phase. Ask Packager to replace its temporary signature after all bundle
        // paths and metadata are final, otherwise macOS can see a corrupted
        // signature and refuse Keychain-backed safeStorage access.
        osxSign: {
          identity: '-',
          identityValidation: false,
        },
      },
    };
  }

  return {
    identity,
    packager: {
      osxSign: { identity },
      ...(hasCompleteNotaryConfig ? {
        osxNotarize: {
          appleApiKey: path.resolve(appleApiKey!),
          appleApiKeyId: appleApiKeyId!,
          appleApiIssuer: appleApiIssuer!,
        },
      } : {}),
    },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean || undefined;
}
