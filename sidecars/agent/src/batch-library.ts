import type { BatchSnapshot } from './types';

export type BatchLibraryState = 'active' | 'error' | 'complete';

export interface BatchLibraryFilters {
  query: string;
  from?: string;
  to?: string;
}

export interface BatchLibraryProgress {
  current: number;
  total: number;
  percent: number;
}

export interface BatchLibraryGroups {
  recent: BatchSnapshot[];
  older: BatchSnapshot[];
}

export function batchLibraryState(batch: Pick<BatchSnapshot, 'queued' | 'running' | 'failed' | 'canceled'>): BatchLibraryState {
  if (batch.queued + batch.running > 0) return 'active';
  if (batch.failed + batch.canceled > 0) return 'error';
  return 'complete';
}

export function batchLibraryProgress(batch: Pick<BatchSnapshot, 'jobs' | 'total'>): BatchLibraryProgress {
  if (!batch.total) return { current: 0, total: 0, percent: 0 };
  const current = Math.max(0, Math.min(batch.total, batch.jobs.filter((job) => (
    job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled'
  )).length));
  const progressUnits = batch.jobs.reduce((total, job) => total + Math.max(0, Math.min(100, job.progress)), 0);
  return {
    current,
    total: batch.total,
    percent: Math.max(0, Math.min(100, progressUnits / batch.total)),
  };
}

export function filterAndGroupBatches(
  batches: BatchSnapshot[],
  filters: BatchLibraryFilters,
  now = new Date(),
): BatchLibraryGroups {
  const filtered = batches
    .filter((batch) => matchesQuery(batch, filters.query))
    .filter((batch) => matchesDateRange(batch.updatedAt, filters.from, filters.to))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return {
    recent: filtered.filter((batch) => isSameLocalDay(batch.updatedAt, now)),
    older: filtered.filter((batch) => !isSameLocalDay(batch.updatedAt, now)),
  };
}

function matchesQuery(batch: BatchSnapshot, query: string): boolean {
  const terms = query.trim().split(/\s+/).map(normalizeSearchText).filter(Boolean);
  if (!terms.length) return true;
  const haystack = normalizeSearchText([
    batch.title,
    batch.prompt,
    batch.offering.displayName,
    batch.offering.providerName,
    batch.offering.tierName,
    ...batch.jobs.flatMap((job) => [job.name, job.prompt, job.error || '']),
  ].join(' '));
  return terms.every((term) => haystack.includes(term) || isSubsequence(term, haystack));
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function matchesDateRange(value: string, from?: string, to?: string): boolean {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const fromTime = from ? localDateBoundary(from, false) : undefined;
  const toTime = to ? localDateBoundary(to, true) : undefined;
  if (fromTime !== undefined && timestamp < fromTime) return false;
  if (toTime !== undefined && timestamp > toTime) return false;
  return true;
}

function localDateBoundary(value: string, endOfDay: boolean): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );
  return date.getTime();
}

function isSameLocalDay(value: string, now: Date): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    && date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}
