import type { ErrorOrigin } from './types';

export function errorOriginLabel(input: {
  origin?: ErrorOrigin;
  source?: 'provider' | 'agent';
  providerName?: string;
  showProviderIdentity: boolean;
}): string {
  if (!input.origin) return '历史错误';
  if (input.origin === 'esse') return 'Esse 侧错误';
  if (input.source === 'agent') return '上游 Agent';
  const providerName = input.providerName?.trim();
  return input.showProviderIdentity && providerName
    ? `上游图片服务 · ${providerName}`
    : '上游图片服务';
}
