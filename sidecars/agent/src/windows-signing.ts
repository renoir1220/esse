import path from 'node:path';

export interface ResolvedWindowsSignOptions {
  certificateFile?: string;
  certificatePassword?: string;
  description?: string;
  hookModulePath?: string;
  signToolPath?: string;
  signWithParams?: string;
  timestampServer?: string;
  website?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function resolveWindowsSignOptions(env: NodeJS.ProcessEnv = process.env): ResolvedWindowsSignOptions | undefined {
  const certificateFile = nonEmpty(env.WINDOWS_CERTIFICATE_FILE);
  const certificatePassword = env.WINDOWS_CERTIFICATE_PASSWORD;
  const signToolPath = nonEmpty(env.WINDOWS_SIGNTOOL_PATH);
  const signWithParams = nonEmpty(env.WINDOWS_SIGN_WITH_PARAMS);
  const hookModulePath = nonEmpty(env.WINDOWS_SIGN_HOOK_MODULE_PATH);
  const usesSignTool = Boolean(certificateFile || signToolPath || signWithParams);

  if (hookModulePath && usesSignTool) {
    throw new Error('Configure either WINDOWS_SIGN_HOOK_MODULE_PATH or SignTool-based Windows signing, not both.');
  }
  if (certificatePassword && !certificateFile) {
    throw new Error('WINDOWS_CERTIFICATE_PASSWORD requires WINDOWS_CERTIFICATE_FILE.');
  }
  if (!hookModulePath && !usesSignTool) return undefined;

  const timestampServer = nonEmpty(env.WINDOWS_TIMESTAMP_SERVER);
  const website = nonEmpty(env.WINDOWS_SIGN_WEBSITE);
  return {
    ...(certificateFile ? { certificateFile: path.resolve(certificateFile) } : {}),
    ...(certificatePassword ? { certificatePassword } : {}),
    ...(signToolPath ? { signToolPath: path.resolve(signToolPath) } : {}),
    ...(signWithParams ? { signWithParams } : {}),
    ...(hookModulePath ? { hookModulePath: path.resolve(hookModulePath) } : {}),
    ...(timestampServer ? { timestampServer } : {}),
    description: nonEmpty(env.WINDOWS_SIGN_DESCRIPTION) ?? 'Esse',
    ...(website ? { website } : {}),
  };
}
