import { describe, expect, it } from 'vitest';
import { PENDING_TASK_HOVER_DELAY_MS, pendingTaskPeekPosition } from './pending-task-peek';

describe('pending task peek placement', () => {
  it('waits long enough to ignore incidental pointer movement', () => {
    expect(PENDING_TASK_HOVER_DELAY_MS).toBe(450);
  });

  it('prefers the right side and keeps the layer inside the viewport', () => {
    expect(pendingTaskPeekPosition(
      { top: 120, right: 210, bottom: 302, left: 28 },
      { width: 900, height: 600 },
    )).toEqual({ left: 218, top: 120, placement: 'right' });
  });

  it('moves left or below when the preferred side has no room', () => {
    expect(pendingTaskPeekPosition(
      { top: 120, right: 888, bottom: 302, left: 706 },
      { width: 900, height: 600 },
    ).placement).toBe('left');
    expect(pendingTaskPeekPosition(
      { top: 80, right: 350, bottom: 262, left: 168 },
      { width: 430, height: 700 },
    ).placement).toBe('below');
  });
});
