import type { BatchSnapshot } from './types';

export interface RetryAllFailedSelection {
  jobIds: string[];
  includesUnknownCharge: boolean;
}

export function retryAllFailedSelection(batch: Pick<BatchSnapshot, 'jobs'>): RetryAllFailedSelection {
  const retryable = batch.jobs.filter((job) => job.status === 'failed' && job.operation !== 'agent');
  return {
    jobIds: retryable.map((job) => job.id),
    includesUnknownCharge: retryable.some((job) => job.chargeState === 'unknown'),
  };
}

export function retrieveTimedOutSelection(batch: Pick<BatchSnapshot, 'jobs'>): string[] {
  return batch.jobs
    .filter((job) => job.status === 'failed' && job.operation !== 'agent' && job.chargeState === 'unknown' && Boolean(job.providerTask)
      && ['not_start', 'submitted', 'queued', 'in_progress', 'completed'].includes(job.providerTask?.status || ''))
    .map((job) => job.id);
}
