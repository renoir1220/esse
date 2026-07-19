import type { PriceConfig } from "./types";

export function offeringPriceLabel(price: PriceConfig): string {
  if (price.mode === "model_quota") return "模型额度";
  if (price.mode === "per_request" && typeof price.amount === "number") {
    const symbol = price.currency === "CNY" ? "¥" : price.currency === "USD" ? "$" : `${price.currency} `;
    return `${symbol}${price.amount.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}/次`;
  }
  if (price.mode === "token") return "Token 计费";
  return "价格未知";
}
