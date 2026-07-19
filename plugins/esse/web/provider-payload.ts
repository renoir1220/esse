import type { OfferingConfig, PriceConfig, ProviderDraft } from "./types";

export function providerSavePayload(draft: ProviderDraft): Record<string, unknown> {
  const displayName = draft.displayName.trim();
  const tierName = draft.tierName.trim();
  const baseUrl = draft.baseUrl.trim();
  if (!displayName || !tierName) throw new Error("请填写服务商名称和档位名称。");
  try { new URL(baseUrl); } catch { throw new Error("请填写有效的 API 地址。"); }
  if (!draft.offerings.length) throw new Error("请至少配置一个模型。");

  return {
    ...(draft.id ? { id: draft.id } : {}),
    displayName,
    tierName,
    baseUrl,
    adapterId: draft.adapterId,
    concurrency: Math.max(1, Math.min(12, Math.trunc(draft.concurrency || 1))),
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    offerings: draft.offerings.map(offeringPayload),
  };
}

function offeringPayload(offering: OfferingConfig): Record<string, unknown> {
  const canonicalModelId = offering.canonicalModelId.trim();
  const providerModelId = offering.providerModelId.trim();
  const displayName = offering.displayName.trim();
  if (!canonicalModelId || !providerModelId || !displayName) throw new Error("每个模型都需要显示名称、服务商模型 ID 和标准模型 ID。");
  return {
    ...(offering.id ? { id: offering.id } : {}),
    canonicalModelId,
    providerModelId,
    displayName,
    price: pricePayload(offering.price),
    supportsTextToImage: Boolean(offering.supportsTextToImage),
    supportsImageToImage: Boolean(offering.supportsImageToImage),
    sizes: offering.sizes.filter(Boolean),
    qualities: offering.qualities.filter(Boolean),
  };
}

function pricePayload(price: PriceConfig): Record<string, unknown> {
  const currency = price.currency.trim();
  if (!currency) throw new Error("请填写模型计费币种。");
  return {
    mode: price.mode,
    currency,
    ...(Number.isFinite(price.amount) ? { amount: price.amount } : {}),
    ...(Number.isFinite(price.inputPerMillion) ? { inputPerMillion: price.inputPerMillion } : {}),
    ...(Number.isFinite(price.outputPerMillion) ? { outputPerMillion: price.outputPerMillion } : {}),
  };
}
