import type { ToolResult } from "./types";

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };
type Listener = (result: ToolResult) => void;

class HostBridge {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<Listener>();
  private initialized: Promise<void> | undefined;

  constructor() {
    window.addEventListener("message", (event) => this.onMessage(event), { passive: true });
    window.addEventListener("openai:set_globals", (event: Event) => {
      const globals = (event as CustomEvent<{ globals?: { toolOutput?: ToolResult["structuredContent"] } }>).detail?.globals;
      if (globals?.toolOutput) this.emit({ structuredContent: globals.toolOutput });
    }, { passive: true });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (window.__ESSE_PREVIEW__) return previewCall(name, args);
    if (window.openai?.callTool) return window.openai.callTool(name, args);
    await this.ensureInitialized();
    return this.request("tools/call", { name, arguments: args }) as Promise<ToolResult>;
  }

  persistState(state: Record<string, unknown>): void {
    window.openai?.setWidgetState?.(state);
  }

  async updateModelContext(text: string): Promise<void> {
    if (window.__ESSE_PREVIEW__) return;
    if (window.openai?.updateModelContext) {
      await window.openai.updateModelContext({ content: [{ type: "text", text }] });
      return;
    }
    await this.ensureInitialized();
    await this.request("ui/update-model-context", { content: [{ type: "text", text }] });
  }

  async sendMessage(text: string): Promise<void> {
    if (window.__ESSE_PREVIEW__) return;
    if (window.openai?.sendFollowUpMessage) {
      await window.openai.sendFollowUpMessage({ prompt: text, scrollToBottom: true });
      return;
    }
    await this.ensureInitialized();
    this.notify("ui/message", { role: "user", content: [{ type: "text", text }] });
  }

  async requestFullscreen(): Promise<void> {
    if (window.openai?.requestDisplayMode) {
      await window.openai.requestDisplayMode({ mode: "fullscreen" });
      return;
    }
    document.body.classList.toggle("standalone-fullscreen");
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.request("ui/initialize", {
          appInfo: { name: "esse", version: "0.1.0" },
          appCapabilities: {},
          protocolVersion: "2026-01-26"
        });
        this.notify("ui/notifications/initialized", {});
      })();
    }
    return this.initialized;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  }

  private notify(method: string, params: unknown): void {
    window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  }

  private onMessage(event: MessageEvent): void {
    if (event.source !== window.parent) return;
    const message = event.data as { jsonrpc?: string; id?: number; method?: string; result?: unknown; error?: unknown; params?: ToolResult };
    if (!message || message.jsonrpc !== "2.0") return;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result" && message.params) this.emit(message.params);
  }

  private emit(result: ToolResult): void {
    for (const listener of this.listeners) listener(result);
  }
}

async function previewCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const state = window.__ESSE_PREVIEW__!;
  if (name === "ui_get_image_preview") {
    const batch = state.batches.find((entry) => entry.id === args.batchId);
    const job = batch?.jobs.find((entry) => entry.id === args.jobId);
    return { structuredContent: { available: Boolean(job?.previewUrl) }, _meta: { dataUrl: job?.previewUrl } };
  }
  if (name === "ui_test_provider_profile") {
    return { structuredContent: { ok: true, modelCount: 3 }, _meta: { models: ["gpt-image-2", "nano-banana-2", "gemini-3.1-flash-image-preview"] } };
  }
  return { structuredContent: { state } };
}

export const bridge = new HostBridge();
