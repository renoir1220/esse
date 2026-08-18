export interface ProviderNetworkSession {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export class ProviderNetworkTransport {
  constructor(private readonly networkSession: ProviderNetworkSession) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const request = input instanceof URL ? input.toString() : input;
    return this.networkSession.fetch(request, init);
  };
}
