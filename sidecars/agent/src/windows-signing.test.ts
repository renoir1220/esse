import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWindowsSignOptions } from './windows-signing';

describe('resolveWindowsSignOptions', () => {
  it('keeps ordinary developer builds unsigned', () => {
    expect(resolveWindowsSignOptions({})).toBeUndefined();
  });

  it('configures an existing certificate without changing its password', () => {
    expect(resolveWindowsSignOptions({
      WINDOWS_CERTIFICATE_FILE: 'secrets/esse.pfx',
      WINDOWS_CERTIFICATE_PASSWORD: '  keep spaces  ',
      WINDOWS_TIMESTAMP_SERVER: 'https://timestamp.example.test',
    })).toEqual({
      certificateFile: path.resolve('secrets/esse.pfx'),
      certificatePassword: '  keep spaces  ',
      timestampServer: 'https://timestamp.example.test',
      description: 'Esse',
    });
  });

  it('supports a cloud or HSM signing hook', () => {
    expect(resolveWindowsSignOptions({
      WINDOWS_SIGN_HOOK_MODULE_PATH: 'signing/provider-hook.cjs',
      WINDOWS_SIGN_WEBSITE: 'https://github.com/renoir1220/esse',
    })).toEqual({
      hookModulePath: path.resolve('signing/provider-hook.cjs'),
      description: 'Esse',
      website: 'https://github.com/renoir1220/esse',
    });
  });

  it('rejects ambiguous or incomplete signing configuration', () => {
    expect(() => resolveWindowsSignOptions({ WINDOWS_CERTIFICATE_PASSWORD: 'secret' })).toThrow(/requires/);
    expect(() => resolveWindowsSignOptions({
      WINDOWS_CERTIFICATE_FILE: 'secrets/esse.pfx',
      WINDOWS_SIGN_HOOK_MODULE_PATH: 'signing/provider-hook.cjs',
    })).toThrow(/either/);
  });
});
