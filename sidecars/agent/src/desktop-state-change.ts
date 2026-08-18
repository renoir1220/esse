import type { DesktopState, DesktopStateChange } from './types';

export function applyDesktopStateChange(state: DesktopState, change: DesktopStateChange): DesktopState {
  if (change.type === 'activate') return { ...state, activeBatchId: change.activeBatchId };
  if (change.type === 'batch-delete') {
    return { ...state, batches: state.batches.filter((batch) => batch.id !== change.batchId), activeBatchId: change.activeBatchId };
  }
  const batches = state.batches.some((batch) => batch.id === change.batch.id)
    ? state.batches.map((batch) => batch.id === change.batch.id ? change.batch : batch)
    : [change.batch, ...state.batches];
  batches.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const images = new Map(state.images.map((image) => [image.id, image]));
  for (const id of change.removedImageIds) images.delete(id);
  for (const image of change.images) images.set(image.id, image);
  return { ...state, batches, images: [...images.values()], activeBatchId: change.activeBatchId };
}
