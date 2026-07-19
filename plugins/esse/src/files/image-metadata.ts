import { open, stat } from "node:fs/promises";

const MAX_HEADER_BYTES = 1024 * 1024;

export interface ImageFileMetadata {
  width?: number;
  height?: number;
  sizeBytes: number;
}

export async function readImageFileMetadata(filePath: string): Promise<ImageFileMetadata> {
  const file = await stat(filePath);
  if (!file.isFile()) throw new Error(`${filePath} is not a file.`);

  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(Math.min(file.size, MAX_HEADER_BYTES));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const dimensions = imageDimensions(header.subarray(0, bytesRead));
    return { ...dimensions, sizeBytes: file.size };
  } finally {
    await handle.close();
  }
}

export function imageDimensions(bytes: Buffer): { width?: number; height?: number } {
  return pngDimensions(bytes)
    || jpegDimensions(bytes)
    || webpDimensions(bytes)
    || gifDimensions(bytes)
    || bmpDimensions(bytes)
    || tiffDimensions(bytes)
    || avifDimensions(bytes)
    || {};
}

function validDimensions(width: number, height: number): { width: number; height: number } | undefined {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : undefined;
}

function pngDimensions(bytes: Buffer) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return undefined;
  return validDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function jpegDimensions(bytes: Buffer) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 1; continue; }
    if (offset + 2 >= bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset + 1);
    if (segmentLength < 2 || offset + segmentLength >= bytes.length) break;
    if (startOfFrameMarkers.has(marker) && offset + 7 < bytes.length) {
      return validDimensions(bytes.readUInt16BE(offset + 6), bytes.readUInt16BE(offset + 4));
    }
    offset += segmentLength + 1;
  }
  return undefined;
}

function webpDimensions(bytes: Buffer) {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + size > bytes.length) break;
    if (type === "VP8X" && size >= 10) return validDimensions(1 + readUInt24LE(bytes, payload + 4), 1 + readUInt24LE(bytes, payload + 7));
    if (type === "VP8L" && size >= 5 && bytes[payload] === 0x2f) {
      const b1 = bytes[payload + 1]!;
      const b2 = bytes[payload + 2]!;
      const b3 = bytes[payload + 3]!;
      const b4 = bytes[payload + 4]!;
      return validDimensions(1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)));
    }
    if (type === "VP8 " && size >= 10 && bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a) {
      return validDimensions(bytes.readUInt16LE(payload + 6) & 0x3fff, bytes.readUInt16LE(payload + 8) & 0x3fff);
    }
    offset = payload + size + (size % 2);
  }
  return undefined;
}

function gifDimensions(bytes: Buffer) {
  if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return undefined;
  return validDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
}

function bmpDimensions(bytes: Buffer) {
  if (bytes.length < 26 || bytes.toString("ascii", 0, 2) !== "BM") return undefined;
  const dibSize = bytes.readUInt32LE(14);
  if (dibSize === 12) return validDimensions(bytes.readUInt16LE(18), bytes.readUInt16LE(20));
  return validDimensions(Math.abs(bytes.readInt32LE(18)), Math.abs(bytes.readInt32LE(22)));
}

function tiffDimensions(bytes: Buffer) {
  if (bytes.length < 16) return undefined;
  const byteOrder = bytes.toString("ascii", 0, 2);
  if (byteOrder !== "II" && byteOrder !== "MM") return undefined;
  const littleEndian = byteOrder === "II";
  const read16 = (offset: number) => littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const read32 = (offset: number) => littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (read16(2) !== 42) return undefined;
  const ifdOffset = read32(4);
  if (ifdOffset + 2 > bytes.length) return undefined;
  const entries = read16(ifdOffset);
  let width: number | undefined;
  let height: number | undefined;
  for (let index = 0; index < entries; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > bytes.length) break;
    const tag = read16(entry);
    if (tag !== 256 && tag !== 257) continue;
    const type = read16(entry + 2);
    const count = read32(entry + 4);
    if (count < 1 || (type !== 3 && type !== 4)) continue;
    const value = type === 3 ? read16(entry + 8) : read32(entry + 8);
    if (tag === 256) width = value; else height = value;
  }
  return width !== undefined && height !== undefined ? validDimensions(width, height) : undefined;
}

function avifDimensions(bytes: Buffer) {
  if (bytes.length < 24 || bytes.toString("ascii", 4, 8) !== "ftyp") return undefined;
  for (let offset = 4; offset + 16 <= bytes.length; offset += 1) {
    if (bytes.toString("ascii", offset, offset + 4) !== "ispe") continue;
    const boxSize = bytes.readUInt32BE(offset - 4);
    if (boxSize < 20 || offset - 4 + boxSize > bytes.length) continue;
    const dimensions = validDimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
    if (dimensions) return dimensions;
  }
  return undefined;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}
