export type EsseDisplayMode = "inline" | "pip" | "fullscreen";

export interface DisplayModeRequestOptions {
  target: EsseDisplayMode;
  getMode: () => EsseDisplayMode | undefined;
  requestMode: (mode: EsseDisplayMode) => Promise<{ mode?: EsseDisplayMode } | void>;
  waitForMode: (mode: EsseDisplayMode, timeoutMs: number) => Promise<boolean>;
  delaysMs?: number[];
  confirmationTimeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export async function requestDisplayModeWithRetry(options: DisplayModeRequestOptions): Promise<void> {
  const delays = options.delaysMs ?? [0, 120, 360];
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let lastError: unknown;
  for (const delayMs of delays) {
    if (options.getMode() === options.target) return;
    if (delayMs > 0) await sleep(delayMs);
    try {
      const response = await options.requestMode(options.target);
      if (response?.mode === options.target || options.getMode() === options.target) return;
      if (await options.waitForMode(options.target, options.confirmationTimeoutMs ?? 420)) return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Host did not enter ${options.target} display mode.`);
}
