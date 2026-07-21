import { describe, expect, it } from 'vitest';
import { shouldDismissOverlay } from './overlay-dismiss';

describe('custom overlay dismissal', () => {
  it('keeps an overlay open for events inside its boundary', () => {
    const target = { closest: (selector: string) => selector === '.batch-picker' ? {} : null } as unknown as EventTarget;
    expect(shouldDismissOverlay(target, '.batch-picker')).toBe(false);
  });

  it('dismisses an overlay for outside or non-element targets', () => {
    const outside = { closest: () => null } as unknown as EventTarget;
    expect(shouldDismissOverlay(outside, '.batch-picker')).toBe(true);
    expect(shouldDismissOverlay(null, '.batch-picker')).toBe(true);
  });

  it('closes the image viewer on its mask but not on the image or controls', () => {
    const mask = { closest: () => null } as unknown as EventTarget;
    const image = { closest: (selector: string) => selector.includes('img') ? {} : null } as unknown as EventTarget;
    const control = { closest: (selector: string) => selector.includes('button') ? {} : null } as unknown as EventTarget;
    expect(shouldDismissOverlay(mask, 'button, img, .lightbox-caption')).toBe(true);
    expect(shouldDismissOverlay(image, 'button, img, .lightbox-caption')).toBe(false);
    expect(shouldDismissOverlay(control, 'button, img, .lightbox-caption')).toBe(false);
  });
});
