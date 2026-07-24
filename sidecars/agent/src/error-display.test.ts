import { describe, expect, it } from 'vitest';
import { errorOriginLabel } from './error-display';

describe('error origin labels', () => {
  it('distinguishes Esse, inconclusive transport, upstream Agent, and legacy failures', () => {
    expect(errorOriginLabel({ origin: 'esse', showProviderIdentity: false })).toBe('Esse 侧错误');
    expect(errorOriginLabel({ origin: 'transport', showProviderIdentity: false })).toBe('请求链路');
    expect(errorOriginLabel({ origin: 'upstream', source: 'agent', showProviderIdentity: false })).toBe('上游 Agent');
    expect(errorOriginLabel({ showProviderIdentity: false })).toBe('历史错误');
  });

  it('reveals provider identity only when the product profile allows it', () => {
    expect(errorOriginLabel({
      origin: 'upstream',
      source: 'provider',
      providerName: 'Example Provider',
      showProviderIdentity: true,
    })).toBe('上游图片服务 · Example Provider');
    expect(errorOriginLabel({
      origin: 'upstream',
      source: 'provider',
      providerName: 'Example Provider',
      showProviderIdentity: false,
    })).toBe('上游图片服务');
  });
});
