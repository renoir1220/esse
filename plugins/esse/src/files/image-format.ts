export const MAX_GENERATED_IMAGE_BYTES = 60 * 1024 * 1024;

export interface ImageFormat {
  mimeType: string;
  extension: string;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

export function detectImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG)) return { mimeType: "image/png", extension: "png" };
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(JPEG)) return { mimeType: "image/jpeg", extension: "jpg" };
  if (buffer.length >= 16
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
    && ["VP8 ", "VP8L", "VP8X"].includes(buffer.subarray(12, 16).toString("ascii"))) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    return { mimeType: "image/gif", extension: "gif" };
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") return { mimeType: "image/bmp", extension: "bmp" };
  if (buffer.length >= 4 && (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
    || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) {
    return { mimeType: "image/tiff", extension: "tiff" };
  }
  if (isAvif(buffer)) return { mimeType: "image/avif", extension: "avif" };
  return undefined;
}

export function decodedBase64Length(value: string): number {
  let meaningful = 0;
  let padding = 0;
  let sawPadding = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code === 0x3d) {
      sawPadding = true;
      padding += 1;
      meaningful += 1;
      continue;
    }
    const isBase64 = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f;
    if (!isBase64 || sawPadding) throw new Error("Provider returned invalid base64 image data.");
    meaningful += 1;
  }
  if (!meaningful || meaningful % 4 !== 0 || padding > 2) throw new Error("Provider returned invalid base64 image data.");
  return Math.floor(meaningful * 3 / 4) - padding;
}

function isAvif(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") return false;
  const boxSize = bytes.readUInt32BE(0);
  if (boxSize < 16 || boxSize > bytes.length) return false;
  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    const brand = bytes.subarray(offset, offset + 4).toString("ascii");
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}
