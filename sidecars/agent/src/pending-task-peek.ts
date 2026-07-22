export interface PeekRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PeekViewport {
  width: number;
  height: number;
}

export interface PeekPosition {
  left: number;
  top: number;
  placement: 'right' | 'left' | 'below' | 'above';
}

export const PENDING_TASK_HOVER_DELAY_MS = 450;

export function pendingTaskPeekPosition(
  rect: PeekRect,
  viewport: PeekViewport,
  size = { width: 286, height: 220 },
): PeekPosition {
  const gap = 8;
  const margin = 12;
  const clampX = (value: number) => Math.min(Math.max(margin, value), Math.max(margin, viewport.width - size.width - margin));
  const clampY = (value: number) => Math.min(Math.max(margin, value), Math.max(margin, viewport.height - size.height - margin));

  if (viewport.width - rect.right >= size.width + gap + margin) {
    return { left: rect.right + gap, top: clampY(rect.top), placement: 'right' };
  }
  if (rect.left >= size.width + gap + margin) {
    return { left: rect.left - size.width - gap, top: clampY(rect.top), placement: 'left' };
  }
  if (viewport.height - rect.bottom >= size.height + gap + margin) {
    return { left: clampX(rect.left), top: rect.bottom + gap, placement: 'below' };
  }
  return { left: clampX(rect.left), top: Math.max(margin, rect.top - size.height - gap), placement: 'above' };
}
