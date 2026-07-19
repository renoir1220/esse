import type { ToolResult } from "./types";
import { compactToolArgs } from "./tool-args";
import { requestDisplayModeWithRetry, type EsseDisplayMode } from "./display-mode";

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
    const cleanArgs = compactToolArgs(args);
    if (window.__ESSE_PREVIEW__) {
      window.__ESSE_LAST_TOOL_CALL__ = { name, args: cleanArgs };
      document.documentElement.dataset.esseLastToolCall = JSON.stringify({ name, args: cleanArgs });
      return previewCall(name, cleanArgs);
    }
    if (window.openai?.callTool) return window.openai.callTool(name, cleanArgs);
    await this.ensureInitialized();
    return this.request("tools/call", { name, arguments: cleanArgs }) as Promise<ToolResult>;
  }

  persistState(state: Record<string, unknown>): void {
    // Codex currently rejects widget-state persistence for a docked MCP App and
    // surfaces a host error banner. Keep this best-effort state inside the
    // iframe session instead of asking the host to persist it.
    try { window.sessionStorage.setItem("esse:widget-state", JSON.stringify(state)); }
    catch { /* Session persistence is optional. */ }
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
    if (window.__ESSE_PREVIEW__) {
      window.__ESSE_LAST_MESSAGE__ = text;
      document.documentElement.dataset.esseLastMessage = text;
      return;
    }
    if (window.openai?.sendFollowUpMessage) {
      await window.openai.sendFollowUpMessage({ prompt: text, scrollToBottom: true });
      return;
    }
    await this.ensureInitialized();
    await this.request("ui/message", { role: "user", content: [{ type: "text", text }] });
  }

  async requestFullscreen(): Promise<void> {
    if (window.__ESSE_PREVIEW__) {
      document.body.classList.toggle("standalone-fullscreen");
      return;
    }
    await requestDisplayModeWithRetry({
      target: "fullscreen",
      getMode: () => window.openai?.displayMode,
      requestMode: async (mode) => {
        if (window.openai?.requestDisplayMode) return window.openai.requestDisplayMode({ mode });
        await this.ensureInitialized();
        return this.request("ui/request-display-mode", { mode }) as Promise<{ mode?: EsseDisplayMode }>;
      },
      waitForMode: (mode, timeoutMs) => this.waitForDisplayMode(mode, timeoutMs)
    });
  }

  private waitForDisplayMode(mode: EsseDisplayMode, timeoutMs: number): Promise<boolean> {
    if (window.openai?.displayMode === mode) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      const finish = (matched: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.removeEventListener("openai:set_globals", onGlobals as EventListener);
        resolve(matched);
      };
      const onGlobals = (event: Event) => {
        const globals = (event as CustomEvent<{ globals?: { displayMode?: EsseDisplayMode } }>).detail?.globals;
        if (globals?.displayMode === mode || window.openai?.displayMode === mode) finish(true);
      };
      timer = window.setTimeout(() => finish(window.openai?.displayMode === mode), timeoutMs);
      window.addEventListener("openai:set_globals", onGlobals as EventListener, { passive: true });
    });
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
  if (name === "ui_list_image_batches") {
    const pageSize = Math.max(4, Math.min(20, Number(args.pageSize) || 8));
    const sorted = [...state.batches].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
    const page = Math.max(1, Math.min(totalPages, Number(args.page) || 1));
    return { structuredContent: { batches: sorted.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: sorted.length, totalPages } };
  }
  if (name === "ui_get_batch_state") {
    const batch = state.batches.find((entry) => entry.id === args.batchId);
    return { structuredContent: { batch } };
  }
  if (name === "ui_check_for_updates") {
    return { structuredContent: { update: { currentVersion: "0.2.0", latestVersion: "0.2.0", updateAvailable: false, checked: true, checkedAt: new Date().toISOString(), releaseUrl: "https://github.com/renoir1220/esse/releases/tag/v0.2.0" } } };
  }
  if (name === "ui_get_image_preview") {
    const batch = state.batches.find((entry) => entry.id === args.batchId);
    const job = batch?.jobs.find((entry) => entry.id === args.jobId);
    const backup = batch?.jobs.flatMap((entry) => entry.backups || []).find((entry) => entry.id === args.jobId) as ({ previewUrl?: string } | undefined);
    const sourceIndex = typeof args.sourceIndex === "number" ? args.sourceIndex : undefined;
    const dataUrl = sourceIndex === undefined ? backup?.previewUrl || job?.previewUrl : job?.referencePreviewUrls?.[sourceIndex] || (sourceIndex === 0 ? job?.previewUrl : undefined);
    return { structuredContent: { available: Boolean(dataUrl), sourceIndex }, _meta: { dataUrl } };
  }
  if (name === "ui_get_image_previews") {
    const batch = state.batches.find((entry) => entry.id === args.batchId);
    const items = Array.isArray(args.items) ? args.items as Array<{ jobId?: unknown; sourceIndex?: unknown; full?: unknown }> : [];
    const previews = items.map((item) => {
      const jobId = String(item.jobId || "");
      const job = batch?.jobs.find((entry) => entry.id === jobId);
      const backup = batch?.jobs.flatMap((entry) => entry.backups || []).find((entry) => entry.id === jobId) as ({ previewUrl?: string } | undefined);
      const sourceIndex = typeof item.sourceIndex === "number" ? item.sourceIndex : undefined;
      const dataUrl = sourceIndex === undefined ? backup?.previewUrl || job?.previewUrl : job?.referencePreviewUrls?.[sourceIndex] || (sourceIndex === 0 ? job?.previewUrl : undefined);
      return { jobId, sourceIndex, full: item.full === true, dataUrl };
    });
    return { structuredContent: { available: previews.filter((item) => item.dataUrl).length }, _meta: { previews } };
  }
  if (name === "ui_get_image_metadata") {
    const batch = state.batches.find((entry) => entry.id === args.batchId);
    const job = batch?.jobs.find((entry) => entry.id === args.jobId);
    const backup = batch?.jobs.flatMap((entry) => entry.backups || []).find((entry) => entry.id === args.jobId);
    return { structuredContent: { available: Boolean(backup?.outputPath || job?.outputPath), width: 2048, height: 1536, sizeBytes: 2_621_440 } };
  }
  if (name === "ui_test_provider_profile") {
    return { structuredContent: { ok: true, modelCount: 3 }, _meta: { models: ["gpt-image-2", "nano-banana-2", "gemini-3.1-flash-image-preview"] } };
  }
  if (name === "ui_set_default_offering") {
    state.defaultOfferingId = String(args.offeringId || "");
    return { structuredContent: { state } };
  }
  if (name === "ui_save_image_as") {
    return { structuredContent: { saved: true, canceled: false, path: `C:\\Users\\demo\\Pictures\\${String(args.jobId || "image")}.png` } };
  }
  if (name === "ui_copy_image_to_clipboard") {
    return { structuredContent: { batchId: args.batchId, jobId: args.jobId, copied: true } };
  }
  if (name === "ui_open_batch_folder") {
    const batch = state.batches.find((entry) => entry.id === args.batchId);
    return { structuredContent: { opened: Boolean(batch), path: batch?.outputDirectory } };
  }
  if (name === "ui_delete_esse_images") {
    const batch = state.batches.find((entry) => entry.id === args.batchId);
    const imageIds = new Set(Array.isArray(args.imageIds) ? args.imageIds.map(String) : []);
    if (batch) {
      batch.jobs = batch.jobs
        .filter((job) => !imageIds.has(job.id))
        .map((job) => ({ ...job, backups: job.backups?.filter((backup) => !imageIds.has(backup.id)) }));
      batch.total = batch.jobs.length;
      batch.queued = batch.jobs.filter((job) => job.status === "queued").length;
      batch.running = batch.jobs.filter((job) => job.status === "running").length;
      batch.succeeded = batch.jobs.filter((job) => job.status === "succeeded").length;
      batch.failed = batch.jobs.filter((job) => job.status === "failed").length;
      state.activeBatch = batch;
      return { structuredContent: { batch } };
    }
  }
  if (name === "modify_selected_images") {
    const batch = state.batches.find((entry) => entry.id === args.batchId);
    const ids = Array.isArray(args.imageIds) ? new Set(args.imageIds) : Array.isArray(args.jobIds) ? new Set(args.jobIds) : new Set<unknown>();
    const selectedOffering = state.offerings.find((offering) => offering.id === args.offeringId);
    if (batch) {
      for (const job of batch.jobs) {
        if (!ids.has(job.id)) continue;
        job.generationInputPath = job.outputPath;
        if (selectedOffering) {
          job.offering = {
            id: selectedOffering.id,
            providerProfileId: selectedOffering.providerProfileId,
            providerName: selectedOffering.providerName,
            tierName: selectedOffering.tierName,
            adapterId: selectedOffering.adapterId,
            canonicalModelId: selectedOffering.canonicalModelId,
            providerModelId: selectedOffering.providerModelId,
            displayName: selectedOffering.displayName,
            concurrency: selectedOffering.concurrency,
            price: selectedOffering.price
          };
        }
        job.prompt = String(args.instructions || job.prompt);
        job.status = "running";
        job.progress = 15;
        job.chargeState = "unknown";
        job.durationMs = undefined;
      }
      batch.running = batch.jobs.filter((job) => job.status === "running").length;
      batch.succeeded = batch.jobs.filter((job) => job.status === "succeeded").length;
      batch.status = "running";
      state.activeBatch = batch;
      return { structuredContent: { batch } };
    }
  }
  return { structuredContent: { state } };
}

export const bridge = new HostBridge();
