export type AdapterId = "tuzi-json-images" | "openai-images";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export interface PriceConfig {
  mode: "per_request" | "token" | "unknown";
  currency: string;
  amount?: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  observedAt?: string;
  note?: string;
}

export interface OfferingConfig {
  id: string;
  canonicalModelId: string;
  providerModelId: string;
  displayName: string;
  price: PriceConfig;
  supportsTextToImage: boolean;
  supportsImageToImage: boolean;
  sizes: string[];
  qualities: string[];
}

export interface ProviderProfile {
  id: string;
  displayName: string;
  tierName: string;
  baseUrl: string;
  adapterId: AdapterId;
  concurrency: number;
  hasApiKey: boolean;
  offerings: OfferingConfig[];
  createdAt: string;
  updatedAt: string;
}

export type ProviderDraft = Omit<ProviderProfile, "id" | "hasApiKey" | "createdAt" | "updatedAt"> & {
  id?: string;
  apiKey: string;
  hasApiKey: boolean;
};

export interface PublicOffering extends OfferingConfig {
  providerProfileId: string;
  providerName: string;
  tierName: string;
  adapterId: AdapterId;
  concurrency: number;
  configured: boolean;
}

export interface JobSnapshot {
  id: string;
  index: number;
  name: string;
  inputPath?: string;
  inputPaths?: string[];
  referenceImagePaths?: string[];
  outputPath?: string;
  generationInputPath?: string;
  generationInputPaths?: string[];
  backups?: JobBackupSnapshot[];
  offering?: BatchSnapshot["offering"];
  prompt: string;
  status: JobStatus;
  progress: number;
  attempt: number;
  retryable: boolean;
  chargeState: "not_charged" | "charged" | "unknown";
  error?: string;
  durationMs?: number;
  previewUrl?: string;
  referencePreviewUrls?: string[];
}

export interface JobBackupSnapshot {
  id: string;
  name: string;
  outputPath: string;
  prompt: string;
  referenceImagePaths?: string[];
  offering?: BatchSnapshot["offering"];
  createdAt: string;
}

export interface BatchSnapshot {
  id: string;
  parentBatchId?: string;
  title: string;
  prompt: string;
  inputDirectory?: string;
  outputDirectory: string;
  offering: {
    id: string;
    providerProfileId: string;
    providerName: string;
    tierName: string;
    adapterId: AdapterId;
    canonicalModelId: string;
    providerModelId: string;
    displayName: string;
    concurrency: number;
    price: PriceConfig;
  };
  jobs: JobSnapshot[];
  status: "queued" | "running" | "completed" | "partial" | "failed" | "canceled";
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  canceled: number;
  estimatedCost?: number;
  currency?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkbenchState {
  view: { tab: "batches" | "settings"; batchId?: string };
  providers: ProviderProfile[];
  offerings: PublicOffering[];
  defaultOfferingId?: string;
  batches: BatchSnapshot[];
  activeBatch?: BatchSnapshot;
  platform: string;
  secureStorage: string;
}

export interface ToolResult {
  structuredContent?: { state?: WorkbenchState; batch?: BatchSnapshot; [key: string]: unknown };
  content?: Array<{ type: string; text?: string }>;
  _meta?: Record<string, unknown>;
}

declare global {
  interface Window {
    openai?: {
      toolOutput?: { state?: WorkbenchState; batch?: BatchSnapshot };
      widgetState?: { tab?: "batches" | "settings"; batchId?: string; selectedJobIds?: string[]; modificationRequest?: string };
      displayMode?: "inline" | "pip" | "fullscreen";
      theme?: "light" | "dark";
      callTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
      setWidgetState?: (state: Record<string, unknown>) => void;
      updateModelContext?: (value: { content: Array<{ type: "text"; text: string }> }) => Promise<void>;
      sendFollowUpMessage?: (value: { prompt: string; scrollToBottom?: boolean }) => Promise<void>;
      requestDisplayMode?: (value: { mode: "fullscreen" }) => Promise<void>;
    };
    __ESSE_PREVIEW__?: WorkbenchState;
  }
}
