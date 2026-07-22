export interface EsseMcpConnection {
  type: 'http';
  url: string;
  headers: { Authorization: string };
  description: string;
}

export function buildAgentSetupPrompt(connection: EsseMcpConnection): string {
  const configuration = {
    mcpServers: {
      esse: connection,
    },
  };
  return [
    '请帮我把 Esse 添加到当前 Agent 的用户级 HTTP MCP 配置中。',
    '请保留已有的 MCP 配置，只新增或更新名为 esse 的服务；不要在回复中回显 Authorization 令牌。',
    '以后使用 Esse 时，请用用户当前使用的语言编写图片提示词；无法判断语言时默认使用简体中文，除非用户明确要求英文。',
    '配置完成后，请检查 Esse MCP 是否能够连接，并告诉我是否需要重启应用或新建任务。',
    '',
    '```json',
    JSON.stringify(configuration, null, 2),
    '```',
  ].join('\n');
}
