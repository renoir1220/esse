import type { BrowserWindowConstructorOptions } from 'electron';

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'autoHideMenuBar' | 'titleBarOverlay' | 'titleBarStyle'
>;

export function desktopWindowChrome(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform !== 'win32') return {};

  return {
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#252523',
      height: 36,
    },
  };
}

export function shouldRemoveWindowMenu(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}
