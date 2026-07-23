export interface ProviderNetworkSession {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  closeAllConnections(): Promise<void>;
  clearHostResolverCache(): Promise<void>;
  forceReloadProxyConfig(): Promise<void>;
}

export class ProviderNetworkTransport {
  private activeRequests = 0;
  private recoveryBarrier: Promise<void> | undefined;
  private resolveRecovery: (() => void) | undefined;
  private recoveryStarted = false;

  constructor(private readonly networkSession: ProviderNetworkSession) {}

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.recoveryBarrier) await this.recoveryBarrier;
    this.activeRequests += 1;
    let waitForRecovery: Promise<void> | undefined;
    try {
      const request = input instanceof URL ? input.toString() : input;
      return await this.networkSession.fetch(request, init);
    } catch (error) {
      waitForRecovery = this.requestRecovery();
      throw error;
    } finally {
      this.activeRequests -= 1;
      this.startRecoveryWhenIdle();
      if (waitForRecovery) await waitForRecovery;
    }
  };

  private requestRecovery(): Promise<void> {
    if (!this.recoveryBarrier) {
      this.recoveryBarrier = new Promise<void>((resolve) => {
        this.resolveRecovery = resolve;
      });
    }
    return this.recoveryBarrier;
  }

  private startRecoveryWhenIdle(): void {
    if (!this.recoveryBarrier || this.recoveryStarted || this.activeRequests > 0) return;
    this.recoveryStarted = true;
    void this.recover().finally(() => {
      const resolve = this.resolveRecovery;
      this.recoveryBarrier = undefined;
      this.resolveRecovery = undefined;
      this.recoveryStarted = false;
      resolve?.();
    });
  }

  private async recover(): Promise<void> {
    await Promise.allSettled([
      this.networkSession.closeAllConnections(),
      this.networkSession.clearHostResolverCache(),
      this.networkSession.forceReloadProxyConfig(),
    ]);
  }
}
