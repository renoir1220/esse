import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MACOS_APP_BUNDLE_ID,
  resolveSidecarUserDataPath,
  shouldQuitWhenAllWindowsClose,
  SIDECAR_USER_DATA_DIRECTORY,
  WINDOWS_SQUIRREL_APP_ID,
} from './platform';

describe('Agent Sidecar platform adapter', () => {
  it('isolates Windows runtime data from the Plugin and the Squirrel application root', () => {
    expect(resolveSidecarUserDataPath('win32', { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, 'C:\\Users\\test'))
      .toBe(path.win32.join('C:\\Users\\test\\AppData\\Local', SIDECAR_USER_DATA_DIRECTORY));
    expect(WINDOWS_SQUIRREL_APP_ID).not.toBe('esse');
    expect(WINDOWS_SQUIRREL_APP_ID).not.toBe(SIDECAR_USER_DATA_DIRECTORY);
  });

  it('uses an isolated Application Support directory on macOS', () => {
    expect(resolveSidecarUserDataPath('darwin', {}, '/Users/test'))
      .toBe(path.posix.join('/Users/test', 'Library', 'Application Support', SIDECAR_USER_DATA_DIRECTORY));
    expect(MACOS_APP_BUNDLE_ID).toBe('com.renoir.esse.agent-sidecar');
  });

  it('keeps the macOS process alive after the last window closes', () => {
    expect(shouldQuitWhenAllWindowsClose('darwin')).toBe(false);
    expect(shouldQuitWhenAllWindowsClose('win32')).toBe(true);
  });
});
