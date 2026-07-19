import type { BatchSnapshot, WorkbenchState } from "./types";

export function keepSelectedBatchId(currentId: string | undefined, incoming: WorkbenchState): string | undefined {
  if (currentId && incoming.batches.some((batch) => batch.id === currentId)) return currentId;
  return incoming.activeBatch?.id || incoming.view.batchId || incoming.batches[0]?.id;
}

export function batchIdAfterStateRefresh(
  currentId: string | undefined,
  current: WorkbenchState,
  incoming: WorkbenchState
): string | undefined {
  const activation = incoming.activation;
  const previousRevision = current.activation?.revision || 0;
  if (activation && activation.revision > previousRevision && incoming.batches.some((batch) => batch.id === activation.batchId)) {
    return activation.batchId;
  }
  return keepSelectedBatchId(currentId, incoming);
}

export function hasNewBatchActivation(current: WorkbenchState, incoming: WorkbenchState): boolean {
  return Boolean(incoming.activation && incoming.activation.revision > (current.activation?.revision || 0));
}

export function isStaleStateRefresh(current: WorkbenchState, incoming: WorkbenchState): boolean {
  return Boolean(current.activation && incoming.activation && incoming.activation.revision < current.activation.revision);
}

export function batchIdAfterUpdate(currentId: string | undefined, batch: BatchSnapshot, activateBatchId?: string): string {
  if (activateBatchId === batch.id) return batch.id;
  return currentId || batch.id;
}

export function mergeBatchWithoutReordering(current: WorkbenchState, batch: BatchSnapshot): WorkbenchState {
  const index = current.batches.findIndex((entry) => entry.id === batch.id);
  const existing = index >= 0 ? current.batches[index] : undefined;
  if (existing && sameBatchRevision(existing, batch)) return current;
  const batches = index >= 0
    ? current.batches.map((entry, batchIndex) => batchIndex === index ? batch : entry)
    : [batch, ...current.batches];
  const useAsActive = !current.activeBatch || current.activeBatch.id === batch.id;
  return {
    ...current,
    batches,
    activeBatch: useAsActive ? batch : current.activeBatch,
    view: current.view.batchId ? current.view : { tab: "batches", batchId: batch.id },
  };
}

export function batchPollDelay(batch: BatchSnapshot | undefined): number {
  return batch && (batch.status === "queued" || batch.status === "running") ? 2_500 : 15_000;
}

function sameBatchRevision(left: BatchSnapshot, right: BatchSnapshot): boolean {
  return left.updatedAt === right.updatedAt
    && left.status === right.status
    && left.queued === right.queued
    && left.running === right.running
    && left.succeeded === right.succeeded
    && left.failed === right.failed
    && left.canceled === right.canceled;
}
