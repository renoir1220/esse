import { ProviderRequestError, type GenerateRequest, type GenerateResult, type ProviderAdapter, type ProviderTaskState, type ProviderTaskStatus } from "../types.js";
import { extractImageResult, IMAGE_REQUEST_TIMEOUT_MS, parseResponse, providerError, requestId, type FetchLike } from "./http.js";

const SUBMIT_TIMEOUT_MS = 2 * 60_000;
const POLL_TIMEOUT_MS = 20_000;

export class TuziJsonImagesAdapter implements ProviderAdapter {
  readonly id = "tuzi-json-images" as const;
  constructor(private readonly options: { baseUrl: string; apiKey: string; fetchImpl?: FetchLike; timeoutMs?: number }) {}

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let task = request.providerTask;
    if (!task) {
      const body: Record<string, unknown> = {
        model: request.model,
        prompt: request.prompt,
        n: 1,
        response_format: request.responseFormat
      };
      if (request.images.length) body.image = request.images;
      if (request.size) body.size = request.size;
      if (request.quality) body.quality = request.quality;
      let response: Response;
      try {
        response = await fetchImpl(`${this.options.baseUrl}/async/v1/images/generations`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: combinedSignal(Math.min(this.options.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS, SUBMIT_TIMEOUT_MS), signal)
        });
      } catch {
        throw new ProviderRequestError("图片任务提交失败；是否已被上游接收及扣费状态未知。", {
          retryable: true, chargeState: "unknown", origin: "transport"
        });
      }
      const parsed = await parseResponse(response);
      if (!response.ok) throw providerError(response, parsed);
      const record = asRecord(parsed);
      const id = firstString(record.id, record.task_id, record.taskId);
      if (!id) throw new ProviderRequestError("图片服务接受了异步请求，但没有返回任务 ID。", {
        retryable: false, chargeState: "unknown", requestId: requestId(response, parsed), origin: "esse"
      });
      const now = new Date().toISOString();
      task = {
        id,
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
        response = await fetchImpl(`${this.options.baseUrl}/get-async?id=${encodeURIComponent(task.id)}`, {
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
      if (status === "completed") return { ...extractImageResult(asyncResult(record.result)), providerRequestId: task.requestId || task.id };
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

function isTransientTaskQueryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function taskStatus(value: unknown): ProviderTaskStatus | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase();
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
