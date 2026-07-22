import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { resolve } from 'node:path';
import { resolveWindowsSignOptions } from './src/windows-signing';
import { resolveMacosSigning } from './src/macos-signing';
import { MACOS_APP_BUNDLE_ID, WINDOWS_SQUIRREL_APP_ID } from './src/platform';
import product from './product.json';

const windowsSign = resolveWindowsSignOptions();
const macosSigning = resolveMacosSigning();
const appIcon = resolve(__dirname, 'assets', 'esse');

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: product.displayName,
    executableName: product.executableName,
    appBundleId: MACOS_APP_BUNDLE_ID,
    helperBundleId: `${MACOS_APP_BUNDLE_ID}.helper`,
    appCategoryType: 'public.app-category.graphics-design',
    icon: appIcon,
    extraResource: [`${appIcon}.png`],
    win32metadata: {
      CompanyName: 'Renoir',
      FileDescription: `${product.displayName} local image workspace`,
      InternalName: product.displayName,
      OriginalFilename: `${product.executableName}.exe`,
      ProductName: product.displayName,
    },
    ...(windowsSign ? { windowsSign } : {}),
    ...macosSigning.packager,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: WINDOWS_SQUIRREL_APP_ID,
      setupExe: product.windowsSetupExe,
      setupIcon: `${appIcon}.ico`,
      noMsi: true,
      ...(windowsSign ? { windowsSign } : {}),
    }, ['win32']),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      name: product.displayName,
      title: product.displayName,
      icon: `${appIcon}.icns`,
      format: 'ULFO',
      overwrite: true,
      ...(macosSigning.identity ? {
        additionalDMGOptions: {
          'code-sign': {
            'signing-identity': macosSigning.identity,
            identifier: `${MACOS_APP_BUNDLE_ID}.dmg`,
          },
        },
      } : {}),
    }, ['darwin']),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
