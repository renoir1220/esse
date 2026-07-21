export function progressivePreviewChunks<T>(values: T[], maximumChunkSize = 4): T[][] {
  if (!Number.isInteger(maximumChunkSize) || maximumChunkSize < 1) throw new Error("Preview chunk size must be a positive integer.");
  const chunks: T[][] = [];
  let offset = 0;
  let size = 1;
  while (offset < values.length) {
    chunks.push(values.slice(offset, offset + size));
    offset += size;
    size = Math.min(maximumChunkSize, size * 2);
  }
  return chunks;
}
