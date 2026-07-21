import type { EsseDesktopBridge } from './types';

declare global {
  interface Window {
    esse: EsseDesktopBridge;
  }
}

export {};
