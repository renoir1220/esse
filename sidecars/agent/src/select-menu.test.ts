import { describe, expect, it } from 'vitest';
import { nextEnabledOptionIndex, type SelectMenuOption } from './select-menu';

const options: SelectMenuOption[] = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B', disabled: true },
  { value: 'c', label: 'C' },
];

describe('select menu keyboard navigation', () => {
  it('skips disabled options in both directions', () => {
    expect(nextEnabledOptionIndex(options, 0, 1)).toBe(2);
    expect(nextEnabledOptionIndex(options, 2, -1)).toBe(0);
  });

  it('wraps around the available options', () => {
    expect(nextEnabledOptionIndex(options, 2, 1)).toBe(0);
    expect(nextEnabledOptionIndex(options, 0, -1)).toBe(2);
  });

  it('reports no target when every option is disabled', () => {
    expect(nextEnabledOptionIndex([{ value: 'x', label: 'X', disabled: true }], 0, 1)).toBe(-1);
  });
});
