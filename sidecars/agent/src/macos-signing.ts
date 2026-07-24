import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ForgeConfig } from '@electron-forge/shared-types';

type PackagerConfig = NonNullable<ForgeConfig['packagerConfig']>;

export interface ResolvedMacosSigning {
  identity?: string;
  packager: Pick<PackagerConfig, 'osxNotarize' | 'osxSign'>;
}

interface PackageResult {
  platform: string;
  outputPaths: string[];
}

type CodesignRunner = (file: string, args: string[], options: { stdio: 'inherit' }) => unknown;

export function resignAdhocMacosBundles(
  result: PackageResult,
  displayName: string,
  developerIdentity: string | undefined,
  runCodesign: CodesignRunner = execFileSync,
): void {
  if (result.platform !== 'darwin' || developerIdentity) return;
  for (const outputPath of result.outputPaths) {
    const appPath = outputPath.endsWith('.app')
      ? outputPath
      : path.join(outputPath, `${displayName}.app`);
    // @electron/osx-sign can leave Electron Framework carrying its original
    // Team ID while the top-level executable is ad-hoc signed. Hardened
    // runtime then rejects the mixed bundle at launch even though a deep
    // structural verification succeeds. Re-sign the finished bundle as one
    // ad-hoc unit after Forge has changed every executable, path, and fuse.
    runCodesign('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  }
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
