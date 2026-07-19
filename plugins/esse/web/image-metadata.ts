export interface ImageMetadata {
  available: boolean;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

export function formatImageResolution(metadata: ImageMetadata | undefined): string {
  if (!metadata) return "读取中…";
  return metadata.width && metadata.height ? `${metadata.width} × ${metadata.height} px` : "未知";
}

export function formatImageFileSize(metadata: ImageMetadata | undefined): string {
  if (!metadata) return "读取中…";
  if (metadata.sizeBytes === undefined || metadata.sizeBytes < 0) return "未知";
  const divisor = metadata.sizeBytes >= 1024 * 1024 ? 1024 * 1024 : 1024;
  const unit = divisor === 1024 ? "KB" : "MB";
  const value = metadata.sizeBytes / divisor;
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(decimals))} ${unit}`;
}
