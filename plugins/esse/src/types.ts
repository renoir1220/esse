export const CODEX_GENERATION_OFFERING_ID = "esse-codex-generation";
export const CODEX_GENERATION_PROFILE_ID = "esse-codex";

export type AdapterId = "tuzi-json-images" | "openai-images" | "agent-generation";
export type PriceMode = "per_request" | "token" | "model_quota" | "unknown";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type JobCallStatus = "running" | "succeeded" | "failed" | "canceled";
export type BatchStatus = "queued" | "running" | "completed" | "partial" | "failed" | "canceled";
export type ChargeState = "not_charged" | "charged" | "unknown";

export interface PriceConfig {
  mode: PriceMode;
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

export interface StoredProviderProfile extends Omit<ProviderProfile, "hasApiKey"> {}

export interface SettingsDocument {
  version: 1;
  providers: StoredProviderProfile[];
  defaultOfferingId?: string;
  updatedAt: string;
}

export interface LocalImageFile {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  mimeType: string;
}

export interface JobRecord {
  id: string;
  index: number;
  name: string;
  inputPath?: string;
  inputPaths?: string[];
  referenceImagePaths?: string[];
  outputPath?: string;
  generationInputPath?: string;
  generationInputPaths?: string[];
  backups?: JobBackup[];
  offering?: OfferingSnapshot;
  prompt: string;
  status: JobStatus;
  progress: number;
  attempt: number;
  retryable: boolean;
  chargeState: ChargeState;
  error?: string;
  providerRequestId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  callHistory?: JobCallRecord[];
}

export interface JobCallRecord {
  id: string;
  sequence: number;
  attempt: number;
  source: "provider" | "agent";
  offering: OfferingSnapshot;
  status: JobCallStatus;
  chargeState: ChargeState;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  providerRequestId?: string;
}

export interface JobBackup {
  id: string;
  name: string;
  outputPath: string;
  prompt: string;
  referenceImagePaths?: string[];
  offering?: OfferingSnapshot;
  createdAt: string;
}

export interface OfferingSnapshot {
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
}

export interface BatchRecord {
  id: string;
  parentBatchId?: string;
  requestKey?: string;
  modificationKeys?: Record<string, string[]>;
  title: string;
  prompt: string;
  inputDirectory?: string;
  outputDirectory: string;
  offering: OfferingSnapshot;
  jobs: JobRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface BatchSnapshot extends BatchRecord {
  status: BatchStatus;
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  canceled: number;
  estimatedCost?: number;
  currency?: string;
}

export interface GenerateRequest {
  model: string;
  prompt: string;
  images: string[];
  size?: string;
  quality?: string;
  responseFormat: "url" | "b64_json";
}

export interface GenerateResult {
  outputUrl?: string;
  b64Json?: string;
  mimeType?: string;
  providerRequestId?: string;
}

export interface ProviderAdapter {
  readonly id: AdapterId;
  generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult>;
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly details: { status?: number; retryable: boolean; chargeState: ChargeState; requestId?: string }
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}
