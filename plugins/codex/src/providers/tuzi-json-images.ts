import { ProviderRequestError, type GenerateRequest, type GenerateResult, type ProviderAdapter, type ProviderTaskState, type ProviderTaskStatus } from "../types.js";
import { extractImageResult, IMAGE_REQUEST_TIMEOUT_MS, parseResponse, providerError, requestId, type FetchLike } from "./http.js";

const SUBMIT_TIMEOUT_MS = 2 * 60_000;
const POLL_TIMEOUT_MS = 20_000;

export class TuziJsonImagesAdapter implements ProviderAdapter {
  readonly id = "tuzi-json-images" as const;
  constructor(private readonly options: { baseUrl: string; apiKey: string; fetchImpl?: FetchLike; timeoutMs?: number }) {}

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const legacyFlash = /^gemini-3\.1-flash-image-preview-(1k|2k|4k)$/.exec(request.model);
    if (legacyFlash) request = { ...request, model: "gemini-3.1-flash-image-preview", quality: request.quality || legacyFlash[1] };
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let task = request.providerTask;
    if (!task) {
      const protocol = submissionProtocol(request.model);
      let response: Response;
      try {
        const submitSignal = combinedSignal(protocol === "sync" ? this.options.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS : Math.min(this.options.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS, SUBMIT_TIMEOUT_MS), signal);
        response = protocol === "video"
          ? await this.video(request, fetchImpl, submitSignal)
          : protocol === "sync" ? await fetchImpl(`${apiBase(this.options.baseUrl)}/v1/images/generations`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: request.model, prompt: request.prompt, n: 1, response_format: "url", ...(ratioSize(request.size, "x") ? { size: ratioSize(request.size, "x") } : {}), ...(request.quality ? { quality: request.quality.toLowerCase() } : {}), ...(request.images.length ? { image: request.images.length === 1 ? request.images[0] : request.images } : {}) }),
            signal: submitSignal
          })
          : request.images.length ? await this.edit(request, fetchImpl, submitSignal) : await fetchImpl(`${apiBase(this.options.baseUrl)}/async/v1/images/generations`, {
            method: "POST", headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: request.model, prompt: request.prompt, n: 1, response_format: request.responseFormat, ...(request.size ? { size: request.size } : {}), ...(request.quality ? { quality: request.quality } : {}) }), signal: submitSignal
          });
      } catch {
        throw new ProviderRequestError("图片任务提交失败；是否已被上游接收及扣费状态未知。", {
          retryable: true, chargeState: "unknown", origin: "transport"
        });
      }
      const parsed = await parseResponse(response);
      if (!response.ok) throw providerError(response, parsed);
      if (protocol === "sync") return { ...extractImageResult(parsed), providerRequestId: requestId(response, parsed) };
      const record = asRecord(parsed);
      const id = firstString(record.id, record.task_id, record.taskId);
      if (!id) throw new ProviderRequestError("图片服务接受了异步请求，但没有返回任务 ID。", {
        retryable: false, chargeState: "unknown", requestId: requestId(response, parsed), origin: "esse"
      });
      const now = new Date().toISOString();
      task = {
        id,
        protocol: protocol === "video" ? "tuzi-video" : "tuzi-images",
        status: taskStatus(record.status) || "queued",
        progress: taskProgress(record.progress),
        requestId: requestId(response, parsed),
        submittedAt: now,
        updatedAt: now
      };
      await request.onProviderTask?.(task);
    }
    return this.poll(task, request.onProviderTask, signal);
  }

  private async video(request: GenerateRequest, fetchImpl: FetchLike, signal: AbortSignal): Promise<Response> {
    const form = new FormData();
    form.set("model", request.model);
    form.set("prompt", request.prompt);
    const size = request.model === "gpt-image-2" ? request.size : ratioSize(request.size, ":");
    if (size && size !== "auto") form.set("size", size);
    if (request.model === "gpt-image-2" && request.quality) form.set("quality", request.quality);
    for (const [index, image] of request.images.entries()) {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(image);
      if (match?.[1] && match[2]) form.append("input_reference", new Blob([Buffer.from(match[2], "base64")], { type: match[1] }), `input-${index + 1}.${extensionForMime(match[1])}`);
      else if (/^https?:\/\//i.test(image)) form.append("input_reference", image);
      else throw new Error("Invalid reference image input.");
    }
    return fetchImpl(`${apiBase(this.options.baseUrl)}/v1/videos`, { method: "POST", headers: { authorization: `Bearer ${this.options.apiKey}` }, body: form, signal });
  }

  private async edit(request: GenerateRequest, fetchImpl: FetchLike, signal: AbortSignal): Promise<Response> {
    const form = new FormData();
    form.append("model", request.model); form.append("prompt", request.prompt); form.append("n", "1"); form.append("response_format", request.responseFormat);
    if (request.size) form.append("size", request.size); if (request.quality) form.append("quality", request.quality);
    for (const [index, image] of request.images.entries()) {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(image);
      if (!match?.[1] || !match[2]) throw new Error("Invalid base64 image input.");
      form.append("image", new Blob([Buffer.from(match[2], "base64")], { type: match[1] }), `input-${index + 1}.${extensionForMime(match[1])}`);
    }
    return fetchImpl(`${apiBase(this.options.baseUrl)}/async/v1/images/edits`, { method: "POST", headers: { authorization: `Bearer ${this.options.apiKey}` }, body: form, signal });
  }

  private async poll(initialTask: ProviderTaskState, onTask: GenerateRequest["onProviderTask"], signal?: AbortSignal): Promise<GenerateResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const totalTimeout = this.options.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS;
    const submitted = Date.parse(initialTask.submittedAt);
    const deadline = (Number.isFinite(submitted) ? submitted : Date.now()) + totalTimeout;
    let task = { ...initialTask };
    let delay = task.status === "queued" ? 1_000 : 0;
    while (true) {
      if (delay) await wait(delay, signal);
      let response: Response;
      let parsed: unknown;
      try {
        const queryUrl = task.protocol === "tuzi-video"
          ? `${apiBase(this.options.baseUrl)}/v1/videos/${encodeURIComponent(task.id)}`
          : `${apiBase(this.options.baseUrl)}/get-async?id=${encodeURIComponent(task.id)}`;
        response = await fetchImpl(queryUrl, {
          headers: { authorization: `Bearer ${this.options.apiKey}` },
          signal: combinedSignal(Math.min(POLL_TIMEOUT_MS, Math.max(1, deadline - Date.now())), signal)
        });
        parsed = await parseResponse(response);
      } catch {
        if (signal?.aborted) throw signal.reason;
        if (Date.now() >= deadline) throw taskTimeout(task, totalTimeout);
        delay = Math.min(Math.max(delay * 2, 1_000), 10_000);
        continue;
      }
      if (!response.ok) {
        const error = providerError(response, parsed);
        if (isTransientTaskQueryStatus(response.status)) {
          if (Date.now() >= deadline) throw taskTimeout(task, totalTimeout);
          delay = Math.min(Math.max(delay * 2, 1_000), 10_000);
          continue;
        }
        throw new ProviderRequestError(error.message, { ...error.details, retryable: true, chargeState: "unknown", requestId: task.requestId });
      }
      const record = asRecord(parsed);
      const status = taskStatus(record.status);
      if (!status) throw new ProviderRequestError("图片服务返回了无法识别的异步任务状态。", {
        retryable: false, chargeState: "unknown", requestId: task.requestId, origin: "upstream"
      });
      const now = new Date().toISOString();
      task = {
        ...task,
        status,
        progress: taskProgress(record.progress),
        requestId: task.requestId || requestId(response, parsed),
        updatedAt: now,
        ...(!task.startedAt && status === "in_progress" ? { startedAt: now } : {}),
        ...(["completed", "failure", "expired"].includes(status) ? { completedAt: now } : {})
      };
      await onTask?.(task);
      if (status === "completed") {
        const result = task.protocol === "tuzi-video" ? { url: record.video_url } : asyncResult(record.result);
        return { ...extractImageResult(result), providerRequestId: task.requestId || task.id };
      }
      if (status === "failure") throw new ProviderRequestError(taskFailureMessage(record), {
        retryable: true, chargeState: "unknown", requestId: task.requestId, origin: "upstream"
      });
      if (status === "expired") throw new ProviderRequestError("图片任务结果已在上游过期，结果与扣费状态需要核对。", {
        retryable: true, chargeState: "unknown", requestId: task.requestId, origin: "upstream"
      });
      if (Date.now() >= deadline) throw taskTimeout(task, totalTimeout);
      delay = Math.min(Math.max(delay * 2, 1_000), 10_000);
    }
  }
}

function taskTimeout(task: ProviderTaskState, timeoutMs: number): ProviderRequestError {
  return new ProviderRequestError(`图片任务在 ${Math.round(timeoutMs / 60_000)} 分钟期限内没有完成；最后确认状态为 ${task.status}，结果与扣费状态未知。`, {
    retryable: true, chargeState: "unknown", requestId: task.requestId, origin: "transport"
  });
}

function submissionProtocol(model: string): "sync" | "video" | "legacy" {
  if (model === "gpt-image-2" || /^gemini-3-pro-image-preview(?:-(?:2k|4k))?-async$/.test(model)) return "video";
  if (model === "gemini-3.1-flash-image-preview"
    || /^gemini-3-pro-image-preview(?:-(?:hd|2k|4k))?$/.test(model)
    || /^nano-banana-2(?:-(?:hd|2k|4k))?$/.test(model)
    || /^gemini-2\.5-flash-image(?:-preview)?$/.test(model)) return "sync";
  return "legacy";
}

function apiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function ratioSize(size: string | undefined, separator: string): string | undefined {
  if (!size || size === "auto") return undefined;
  const match = /^(\d+)[x:](\d+)$/i.exec(size);
  if (!match) return size;
  let width = Number(match[1]); let height = Number(match[2]);
  if (width > 32 || height > 32) {
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    const divisor = gcd(width, height);
    if (divisor) { width /= divisor; height /= divisor; }
  }
  return `${width}${separator}${height}`;
}

function isTransientTaskQueryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function taskStatus(value: unknown): ProviderTaskStatus | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase();
  if (clean === "succeeded") return "completed";
  if (clean === "failed") return "failure";
  if (clean === "processing") return "in_progress";
  return ["not_start", "submitted", "queued", "in_progress", "completed", "failure", "expired"].includes(clean)
    ? clean as ProviderTaskStatus
    : undefined;
}

function taskProgress(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : undefined;
}

function taskFailureMessage(record: Record<string, unknown>): string {
  const error = asRecord(record.error);
  const result = asRecord(record.result);
  const resultError = asRecord(result.error);
  return sanitize(firstString(error.message, resultError.message, record.message, result.message, error.code, resultError.code)
    || "图片服务确认异步任务失败。");
}

function asyncResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function sanitize(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 800);
}

function extensionForMime(mime: string): string {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}
