interface ClosestTarget {
  closest(selector: string): unknown;
}

export function shouldDismissOverlay(target: EventTarget | null, boundarySelector: string): boolean {
  return !isClosestTarget(target) || !target.closest(boundarySelector);
}

function isClosestTarget(value: unknown): value is ClosestTarget {
  return Boolean(value && typeof value === 'object' && 'closest' in value && typeof (value as ClosestTarget).closest === 'function');
}
