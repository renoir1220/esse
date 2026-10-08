import { describe, expect, it } from 'vitest';
import { buildAgentSetupPrompt } from './agent-setup-prompt';

describe('Agent setup prompt', () => {
  it('copies a paste-and-send instruction with a complete MCP configuration', () => {
    const prompt = buildAgentSetupPrompt({
      type: 'http',
      url: 'http://127.0.0.1:43181/mcp',
      headers: { Authorization: 'Bearer local-pairing-token' },
      description: 'Esse local image generation',
    });

    expect(prompt).toContain('用户级 HTTP MCP');
    expect(prompt).toContain('保留已有的 MCP 配置');
    expect(prompt).toContain('不要在回复中回显 Authorization 令牌');
    expect(prompt).toContain('用户当前使用的语言');
    expect(prompt).toContain('默认使用简体中文');
    expect(prompt).toContain('providers.json');
    expect(prompt).toContain('settings.json');
    expect(prompt).toContain('API Key 不在 providers.json 中');
    expect(prompt).toContain('外部编辑后必须提醒用户重启 Esse');
    expect(prompt).toContain('"mcpServers"');
    expect(prompt).toContain('"esse"');
    expect(prompt).toContain('Bearer local-pairing-token');
  });

  it('includes the exact private configuration paths when Esse supplies them', () => {
    const prompt = buildAgentSetupPrompt({
      type: 'http',
      url: 'http://127.0.0.1:43181/mcp',
      headers: { Authorization: 'Bearer local-pairing-token' },
      description: 'Esse local image generation',
      providerConfigPath: 'C:\\Users\\test\\AppData\\Local\\esse-agent-sidecar\\providers.json',
      settingsConfigPath: 'C:\\Users\\test\\AppData\\Local\\esse-agent-sidecar\\settings.json',
    });

    expect(prompt).toContain('C:\\Users\\test\\AppData\\Local\\esse-agent-sidecar\\providers.json');
    expect(prompt).toContain('C:\\Users\\test\\AppData\\Local\\esse-agent-sidecar\\settings.json');
    const configuration = JSON.parse(prompt.match(/```json\n([\s\S]+?)\n```/)?.[1] || '{}') as { mcpServers?: { esse?: Record<string, unknown> } };
    expect(configuration.mcpServers?.esse).not.toHaveProperty('providerConfigPath');
    expect(configuration.mcpServers?.esse).not.toHaveProperty('settingsConfigPath');
  });
});
