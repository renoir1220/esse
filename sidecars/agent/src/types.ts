export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type BatchStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'canceled';
export type ChargeState = 'not_charged' | 'charged' | 'unknown';
export type BatchOperation = 'generate' | 'modify' | 'agent';

export type AdapterId = 'tuzi-json-images' | 'openai-images' | 'agent-generation';
export type PriceMode = 'per_request' | 'token' | 'model_quota' | 'unknown';

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
  adapterId: Exclude<AdapterId, 'agent-generation'>;
  concurrency: number;
  hasApiKey: boolean;
  offerings: OfferingConfig[];
  createdAt: string;
  updatedAt: string;
}

export type ProviderDraft = Omit<ProviderProfile, 'id' | 'hasApiKey' | 'createdAt' | 'updatedAt'> & {
  id?: string;
  apiKey: string;
  hasApiKey: boolean;
};

export interface SaveProviderInput {
  id?: string;
  displayName: string;
  tierName: string;
  baseUrl: string;
  adapterId: Exclude<AdapterId, 'agent-generation'>;
  concurrency: number;
  apiKey?: string;
  offerings: OfferingConfig[];
}

export interface OfferingSummary {
  id: string;
  canonicalModelId: string;
  providerModelId: string;
  displayName: string;
  providerName: string;
  providerType: string;
  tierName: string;
  concurrency: number;
  priceMicros: number;
  currency: string;
  price: PriceConfig;
  configured: boolean;
  sizes: string[];
  supportsTextToImage: boolean;
  supportsImageToImage: boolean;
}

export const WORKBUDDY_AGENT_OFFERING: OfferingSummary = {
  id: 'workbuddy-agent-generation',
  canonicalModelId: 'workbuddy-agent-generation',
  providerModelId: 'current-workbuddy-agent',
  displayName: 'WorkBuddy 生成',
  providerName: 'Current WorkBuddy Agent',
  providerType: 'agent-generation',
  tierName: '内置',
  concurrency: 1,
  priceMicros: 0,
  currency: 'CNY',
  price: { mode: 'model_quota', currency: 'MODEL' },
  configured: true,
  sizes: [],
  supportsTextToImage: true,
  supportsImageToImage: true,
};

export interface SavedImage {
  id: string;
  requestId: string;
  mediaUrl: string;
  fileName: string;
  sourceFileName?: string;
  prompt: string;
  model: string;
  revisedPrompt?: string;
  createdAt: string;
}

export interface ImageMetadata {
  available: boolean;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

export interface JobBackup {
  id: string;
  name: string;
  imageId: string;
  prompt: string;
  referenceImageIds?: string[];
  offering?: OfferingSummary;
  createdAt: string;
}

export interface JobCallRecord {
  id: string;
  sequence?: number;
  attempt: number;
  source?: 'provider' | 'agent';
  offering?: OfferingSummary;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  chargeState: ChargeState;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  requestId?: string;
  error?: string;
}

export interface BatchJob {
  id: string;
  index: number;
  name: string;
  prompt: string;
  requestKey: string;
  operation: BatchOperation;
  status: JobStatus;
  progress: number;
  attempt: number;
  retryable: boolean;
  chargeState: ChargeState;
  referenceImageIds: string[];
  outputImageId?: string;
  backups: JobBackup[];
  error?: string;
  requestId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  callHistory: JobCallRecord[];
  generationOptions?: { size?: string; quality?: string };
  offering?: OfferingSummary;
}

export interface BatchRecord {
  id: string;
  parentBatchId?: string;
  requestKey?: string;
  appendKeys: Record<string, string[]>;
  modificationKeys: Record<string, string[]>;
  mergeKeys: Record<string, string[]>;
  title: string;
  prompt: string;
  offering: OfferingSummary;
  jobs: BatchJob[];
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
  estimatedCostMicros: number;
}

export interface GenerateInput {
  prompt: string;
  model: string;
  size?: string;
  quality?: string;
  n?: number;
}

export interface BatchJobInput {
  prompt: string;
  referenceImageIds?: string[];
}

export interface CreateBatchInput {
  title?: string;
  offeringId?: string;
  prompt?: string;
  jobs?: BatchJobInput[];
  count?: number;
  size?: string;
  quality?: string;
  requestKey: string;
  approvedEstimatedCostMicros?: number;
}

export interface AppendBatchInput {
  batchId: string;
  jobs: BatchJobInput[];
  offeringId?: string;
  size?: string;
  quality?: string;
  requestKey: string;
  approvedEstimatedCostMicros?: number;
}

export interface ModifyBatchInput {
  batchId: string;
  imageIds: string[];
  referenceImageIds?: string[];
  prompt: string;
  offeringId?: string;
  size?: string;
  quality?: string;
  requestKey: string;
  approvedEstimatedCostMicros?: number;
}

export interface DesktopState {
  configured: boolean;
  providers: ProviderProfile[];
  offerings: OfferingSummary[];
  defaultOfferingId?: string;
  images: SavedImage[];
  batches: BatchSnapshot[];
  activeBatchId?: string;
  mcp: McpStatus;
  platform: string;
  secureStorage: string;
  error?: string;
}

export interface McpStatus {
  available: boolean;
  endpoint: string;
  error?: string;
}

export interface EsseDesktopBridge {
  getState(): Promise<DesktopState>;
  refresh(): Promise<DesktopState>;
  saveProvider(input: SaveProviderInput): Promise<DesktopState>;
  deleteProvider(id: string): Promise<DesktopState>;
  testProvider(input: { baseUrl: string; profileId?: string; apiKey?: string }): Promise<{ models: string[]; requestId?: string }>;
  modifyBatch(input: ModifyBatchInput): Promise<DesktopState>;
  cancelQueued(batchId: string): Promise<DesktopState>;
  retryJobs(batchId: string, jobIds: string[], allowUnknownCharge?: boolean): Promise<DesktopState>;
  deleteImages(batchId: string, imageIds: string[]): Promise<DesktopState>;
  deleteBatch(batchId: string): Promise<DesktopState>;
  activateBatch(batchId: string): Promise<DesktopState>;
  setDefaultOffering(offeringId: string): Promise<DesktopState>;
  openImage(id: string): Promise<void>;
  revealImage(id: string): Promise<void>;
  getImageMetadata(id: string): Promise<ImageMetadata>;
  copyImage(id: string): Promise<void>;
  saveImage(id: string): Promise<string | undefined>;
  openBatchFolder(batchId: string): Promise<void>;
  copyWorkBuddyConfig(): Promise<void>;
  onStateChanged(callback: (state: DesktopState) => void): () => void;
  onNavigate(callback: (input: { tab: 'batches' | 'settings'; batchId?: string }) => void): () => void;
  reportReady(details: { title: string; bridgeAvailable: boolean }): void;
}
