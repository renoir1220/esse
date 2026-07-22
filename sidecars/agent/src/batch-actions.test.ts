import { describe, expect, it } from 'vitest';
import { retryAllFailedSelection } from './batch-actions';
import type { BatchJob } from './types';

describe('Batch actions', () => {
  it('selects every Provider failure for manual retry regardless of automatic retry eligibility', () => {
    const jobs = [
      job('failed-safe', 'failed', true, 'not_charged'),
      job('failed-unknown', 'failed', true, 'unknown'),
      job('failed-terminal', 'failed', false, 'not_charged'),
      job('failed-agent', 'failed', false, 'unknown', 'agent'),
      job('completed', 'succeeded', false, 'charged'),
    ];

    expect(retryAllFailedSelection({ jobs })).toEqual({
      jobIds: ['failed-safe', 'failed-unknown', 'failed-terminal'],
      includesUnknownCharge: true,
    });
  });
});

function job(id: string, status: BatchJob['status'], retryable: boolean, chargeState: BatchJob['chargeState'], operation: BatchJob['operation'] = 'generate'): BatchJob {
  return {
    id,
    index: 0,
    name: id,
    prompt: id,
    requestKey: id,
    operation,
    status,
    progress: status === 'succeeded' ? 100 : 0,
    attempt: 1,
    retryable,
    chargeState,
    referenceImageIds: [],
    backups: [],
    createdAt: '2026-07-22T00:00:00.000Z',
    callHistory: [],
  };
}
