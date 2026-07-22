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
