export interface ResourceReadResult {
  contents: Array<{ uri: string; mimeType?: string; blob?: string; text?: string }>;
}

const MAX_ORIGINAL_IMAGE_BYTES = 60 * 1024 * 1024;

export function originalImageDataUrl(result: ResourceReadResult): string {
  const content = result.contents.find((item) => typeof item.blob === "string");
  if (!content?.blob) throw new Error("MCP 原图资源没有返回图片数据。");
  if (!content.mimeType?.startsWith("image/")) throw new Error("MCP 原图资源返回了不支持的文件类型。");
  if (base64ByteLength(content.blob) > MAX_ORIGINAL_IMAGE_BYTES) throw new Error("原图超过 60 MB，无法在 Esse 中打开。");
  return `data:${content.mimeType};base64,${content.blob}`;
}

function base64ByteLength(value: string): number {
  if (value.length % 4 !== 0) throw new Error("MCP 原图资源返回了无效的图片编码。");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}
