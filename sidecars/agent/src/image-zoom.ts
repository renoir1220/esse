export type ImageZoom = { scale: number; x: number; y: number };

export const initialImageZoom: ImageZoom = { scale: 1, x: 0, y: 0 };

export function zoomImageAtPoint(current: ImageZoom, deltaY: number, pointX: number, pointY: number, deltaMode = 0, pageHeight = 800): ImageZoom {
  const pixelDelta = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
  const nextScale = Math.min(8, Math.max(1, current.scale * Math.exp(-pixelDelta * 0.0015)));
  if (nextScale <= 1.0001) return initialImageZoom;
  if (nextScale === current.scale) return current;
  const ratio = nextScale / current.scale;
  return { scale: nextScale, x: pointX - ratio * (pointX - current.x), y: pointY - ratio * (pointY - current.y) };
}
