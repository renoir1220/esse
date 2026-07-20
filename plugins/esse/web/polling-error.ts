export const TRANSPORT_CLOSED_NOTICE = "Esse 连接已关闭，请重启 Codex 后新建任务。";

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "本地插件操作失败。";
}

export function resolveBackgroundPollingError(error: unknown, transportAlreadyClosed = false): { stop: boolean; notice?: string } {
  const transportClosed = /\btransport\s+(?:is\s+)?closed\b/i.test(errorMessage(error));
  if (!transportClosed) return { stop: false, notice: errorMessage(error) };
  return { stop: true, notice: transportAlreadyClosed ? undefined : TRANSPORT_CLOSED_NOTICE };
}
