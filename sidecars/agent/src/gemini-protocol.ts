// REST contract: https://ai.google.dev/api/generate-content and
// https://ai.google.dev/gemini-api/docs/generate-content/image-generation
export class GeminiInputError extends Error {}

export function geminiApiRoot(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (url.search || url.hash || url.username || url.password) throw new GeminiInputError('Gemini API 地址不能包含查询参数、片段或账号信息。');
  const base = url.toString().replace(/\/+$/, '');
  return /\/v1(?:beta)?$/.test(base) ? base : `${base}/v1beta`;
}

export function geminiRequest(input: { model: string; prompt: string; size?: string; quality?: string; n?: number; images: string[] }): { endpoint: string; body: string } {
  if (!/^[a-zA-Z0-9._-]+$/.test(input.model)) throw new GeminiInputError('请填写 Gemini 官方模型 ID，不能包含路径或查询参数。');
  if ((input.n ?? 1) !== 1) throw new GeminiInputError('Gemini 每个任务只生成一张图片，请使用批次生成多张。');
  const legacy = input.model === 'gemini-2.5-flash-image' || input.model === 'gemini-2.5-flash-image-preview';
  const maxReferences = legacy ? 3 : 14;
  if (input.images.length > maxReferences) throw new GeminiInputError(`这个 Gemini 模型最多支持 ${maxReferences} 张参考图。`);
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: input.prompt }];
  for (const image of input.images) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/]+={0,2})$/.exec(image);
    if (!match?.[1] || !match[2] || match[2].length % 4 !== 0) throw new GeminiInputError('Esse 的 Gemini 参考图请使用 PNG、JPEG 或 WebP。');
    parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }
  const imageConfig: { aspectRatio?: string; imageSize?: string } = {};
  if (input.size && input.size !== 'auto') {
    const dimensions = /^(\d+)[x:](\d+)$/.exec(input.size);
    if (!dimensions) throw new GeminiInputError('Gemini 尺寸请使用比例，例如 9:16 或 16:9。');
    const width = Number(dimensions[1]);
    const height = Number(dimensions[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new GeminiInputError('Gemini 尺寸必须是正整数比例。');
    let a = width;
    let b = height;
    while (b) [a, b] = [b, a % b];
    const reduced = `${width / a}:${height / a}`;
    const ratio = reduced === '7:3' ? '21:9' : reduced;
    if (!['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'].includes(ratio)) throw new GeminiInputError('Gemini 尺寸请使用比例，例如 9:16 或 16:9。');
    if ((legacy || /^gemini-3-pro-image(?:-preview)?$/.test(input.model)) && ['1:4', '4:1', '1:8', '8:1'].includes(ratio)) throw new GeminiInputError('这个 Gemini 模型不支持所选的超宽或超长比例。');
    imageConfig.aspectRatio = ratio;
  }
  if (input.quality && input.quality !== 'auto') {
    const imageSize = input.quality.toUpperCase();
    if (!['512', '1K', '2K', '4K'].includes(imageSize)) throw new GeminiInputError('Gemini 分辨率请使用 1K、2K、4K；Flash Image 另支持 512。');
    if (legacy && imageSize !== '1K') throw new GeminiInputError('Gemini 2.5 Flash Image 只支持默认 1K 分辨率。');
    if (imageSize === '512' && !/^gemini-3\.1-flash-image(?:-preview)?$/.test(input.model)) throw new GeminiInputError('512 分辨率只支持 Gemini 3.1 Flash Image。');
    if (/^gemini-3\.1-flash-lite-image/.test(input.model) && imageSize !== '1K') throw new GeminiInputError('Gemini Flash Lite Image 只支持 1K 分辨率。');
    if (!legacy) imageConfig.imageSize = imageSize;
  }
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) } });
  if (new TextEncoder().encode(body).byteLength >= 20_000_000) throw new GeminiInputError('Gemini 内联请求必须小于 20 MB，请减少参考图大小或数量。');
  return { endpoint: `/models/${input.model}:generateContent`, body };
}

export function geminiImages(body: unknown): Array<{ b64Json: string; mimeType: string }> {
  const record = asRecord(body);
  const candidate = asRecord(Array.isArray(record.candidates) ? record.candidates[0] : undefined);
  const content = asRecord(candidate.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.flatMap((value) => {
    const part = asRecord(value);
    if (part.thought === true) return [];
    const blob = asRecord(part.inlineData || part.inline_data);
    const mime = blob.mimeType || blob.mime_type;
    const data = blob.data;
    if (typeof mime !== 'string' || !/^image\/(?:png|jpeg|webp)$/.test(mime) || typeof data !== 'string' || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return [];
    return [{ b64Json: data, mimeType: mime }];
  });
}

export function geminiResponseId(body: unknown): string | undefined {
  const id = asRecord(body).responseId;
  return typeof id === 'string' && id ? id : undefined;
}

export function geminiBlockReason(body: unknown): string | undefined {
  const record = asRecord(body);
  const feedback = asRecord(record.promptFeedback);
  const candidate = asRecord(Array.isArray(record.candidates) ? record.candidates[0] : undefined);
  const reason = feedback.blockReason || candidate.finishReason;
  return typeof reason === 'string' && /^[A-Z_]{1,64}$/.test(reason) && reason !== 'STOP' ? reason : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
