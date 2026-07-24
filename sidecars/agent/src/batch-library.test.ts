import { describe, expect, it } from 'vitest';
import { batchLibraryProgress, batchLibraryState, filterAndGroupBatches } from './batch-library';
import type { BatchSnapshot } from './types';

describe('batch library state', () => {
  it('shows active work before terminal errors', () => {
    expect(batchLibraryState(batch({ queued: 2, running: 1, failed: 1 }))).toBe('active');
  });

  it('treats interrupted and canceled terminal work as errors', () => {
    expect(batchLibraryState(batch({ failed: 1 }))).toBe('error');
    expect(batchLibraryState(batch({ canceled: 1 }))).toBe('error');
  });

  it('uses current job state so a successful retry is clean', () => {
    const retried = batch();
    retried.jobs[0]!.callHistory = [
      { id: 'call-1', attempt: 1, status: 'failed', chargeState: 'unknown', startedAt: retried.createdAt },
      { id: 'call-2', attempt: 2, status: 'succeeded', chargeState: 'charged', startedAt: retried.createdAt },
    ];
    expect(batchLibraryState(retried)).toBe('complete');
  });

  it('reports completed work against all tasks and keeps progress bounded', () => {
    const active = batch({ queued: 2, running: 1, succeeded: 2, total: 5 });
    active.jobs = [
      job('succeeded', 100),
      job('succeeded', 100),
      job('running', 40),
      job('queued', 0),
      job('queued', 0),
    ];
    expect(batchLibraryProgress(active)).toEqual({ current: 2, total: 5, percent: 48 });
  });
});

describe('batch library filtering and grouping', () => {
  const now = new Date(2026, 6, 24, 12, 0, 0);
  const today = batch({
    id: 'today',
    title: '电影海报修改',
    createdAt: new Date(2026, 6, 20, 9, 0, 0).toISOString(),
    updatedAt: new Date(2026, 6, 24, 10, 0, 0).toISOString(),
  });
  const older = batch({
    id: 'older',
    title: '产品静物',
    createdAt: new Date(2026, 5, 10, 9, 0, 0).toISOString(),
    updatedAt: new Date(2026, 5, 12, 10, 0, 0).toISOString(),
  });

  it('treats an older batch modified today as recent and sorts by update time', () => {
    expect(filterAndGroupBatches([older, today], { query: '' }, now)).toEqual({ recent: [today], older: [older] });
  });

  it('supports compact and subsequence Chinese fuzzy matching', () => {
    expect(filterAndGroupBatches([older, today], { query: '电影 海报' }, now).recent).toEqual([today]);
    expect(filterAndGroupBatches([older, today], { query: '电报修' }, now).recent).toEqual([today]);
  });

  it('filters inclusively by local update date with no default range', () => {
    expect(filterAndGroupBatches([older, today], { query: '' }, now).older).toEqual([older]);
    expect(filterAndGroupBatches([older, today], { query: '', from: '2026-07-24', to: '2026-07-24' }, now)).toEqual({ recent: [today], older: [] });
  });
});

function batch(overrides: Partial<BatchSnapshot> = {}): BatchSnapshot {
  const createdAt = overrides.createdAt || new Date(2026, 6, 24, 8, 0, 0).toISOString();
  const total = overrides.total ?? 1;
  const queued = overrides.queued ?? 0;
  const running = overrides.running ?? 0;
  const succeeded = overrides.succeeded ?? Math.max(0, total - queued - running - (overrides.failed ?? 0) - (overrides.canceled ?? 0));
  const failed = overrides.failed ?? 0;
  const canceled = overrides.canceled ?? 0;
  return {
    id: overrides.id || 'batch-1',
    appendKeys: {},
    modificationKeys: {},
    mergeKeys: {},
    title: overrides.title || '测试批次',
    prompt: '生成测试图片',
    offering: {
      id: 'offering',
      canonicalModelId: 'model',
      providerModelId: 'model',
      displayName: '图像模型',
      providerName: '服务商',
      providerType: 'provider',
      tierName: '默认',
      concurrency: 3,
      priceMicros: 0,
      currency: 'CNY',
      price: { mode: 'unknown', currency: 'CNY' },
      configured: true,
      sizes: [],
      supportsTextToImage: true,
      supportsImageToImage: true,
    },
    jobs: overrides.jobs || Array.from({ length: total }, (_, index) => job(index < succeeded ? 'succeeded' : index < succeeded + failed ? 'failed' : index < succeeded + failed + canceled ? 'canceled' : index < succeeded + failed + canceled + running ? 'running' : 'queued', index < succeeded + failed + canceled ? 100 : index < succeeded + failed + canceled + running ? 15 : 0, index)),
    createdAt,
    updatedAt: overrides.updatedAt || createdAt,
    status: running ? 'running' : queued ? 'queued' : failed && succeeded ? 'partial' : failed ? 'failed' : canceled === total ? 'canceled' : 'completed',
    total,
    queued,
    running,
    succeeded,
    failed,
    canceled,
    estimatedCostMicros: 0,
    ...overrides,
  };
}

function job(status: BatchSnapshot['jobs'][number]['status'], progress: number, index = 0): BatchSnapshot['jobs'][number] {
  return {
    id: `job-${index}`,
    index,
    name: `图${index + 1}`,
    prompt: '生成测试图片',
    requestKey: `request-${index}`,
    operation: 'generate',
    status,
    progress,
    attempt: 1,
    retryable: status === 'failed',
    chargeState: status === 'failed' ? 'unknown' : status === 'succeeded' ? 'charged' : 'not_charged',
    referenceImageIds: [],
    backups: [],
    createdAt: new Date(2026, 6, 24, 8, 0, 0).toISOString(),
    callHistory: [],
  };
}
