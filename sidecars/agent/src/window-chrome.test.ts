import { describe, expect, it } from 'vitest';
import { desktopWindowChrome, shouldRemoveWindowMenu } from './window-chrome';

describe('desktopWindowChrome', () => {
  it('uses an integrated light title bar and no menu on Windows', () => {
    expect(desktopWindowChrome('win32')).toEqual({
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#ffffff',
        symbolColor: '#252523',
        height: 36,
      },
    });
    expect(shouldRemoveWindowMenu('win32')).toBe(true);
  });

  it('preserves native window chrome and menus away from Windows', () => {
    expect(desktopWindowChrome('darwin')).toEqual({});
    expect(shouldRemoveWindowMenu('darwin')).toBe(false);
  });
});
