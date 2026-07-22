import os from 'node:os';
import path from 'node:path';
import product from '../product.json';

export const SIDECAR_USER_DATA_DIRECTORY = product.userDataDirectory;
export const WINDOWS_SQUIRREL_APP_ID = product.windowsSquirrelAppId;
export const MACOS_APP_BUNDLE_ID = product.macosAppBundleId;

export function resolveSidecarUserDataPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homeDirectory, 'AppData', 'Local');
    return path.win32.join(localAppData, SIDECAR_USER_DATA_DIRECTORY);
  }
  if (platform === 'darwin') {
    return path.posix.join(homeDirectory, 'Library', 'Application Support', SIDECAR_USER_DATA_DIRECTORY);
  }
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(homeDirectory, '.config'), SIDECAR_USER_DATA_DIRECTORY);
}

export function shouldQuitWhenAllWindowsClose(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'darwin';
}
