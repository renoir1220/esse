export interface ProviderConfigPaths {
  providerConfigPath?: string;
  settingsConfigPath?: string;
}

export function buildProviderConfigGuidance(paths: ProviderConfigPaths = {}): string {
  const providerPath = paths.providerConfigPath || '<Esse userData>/providers.json';
  const settingsPath = paths.settingsConfigPath || '<Esse userData>/settings.json';
  return [
    'Provider 配置（仅当用户明确询问或要求修改 Provider/模型时）：Esse 没有 Provider 配置 MCP 写接口；请使用本机文件工具读取或修改下面的配置文件。',
    `- Provider、URL、适配器、并发数和模型列表：${providerPath}`,
    `- 默认模型（offering ID）：${settingsPath}`,
    'providers.json 是 version=1 的 JSON，根节点保留 version、providers、updatedAt；每个 Provider 保留稳定的 id、displayName、tierName、baseUrl、adapterId、concurrency、offerings、createdAt、updatedAt。',
    'adapterId 只能使用 tuzi-json-images 或 openai-images；每个 Provider 至少保留一个 offering。每个 offering 必须有稳定的 id、canonicalModelId、providerModelId、displayName、price、supportsTextToImage、supportsImageToImage、sizes 和 qualities。',
    '修改模型名或 Provider 路由时，尽量只改对应字段并保留现有 offering.id；不要因为编辑而重新启用用户已禁用的模型。新增模型时复制同一 Provider 的完整 offering 结构并使用新的稳定 id。',
    'API Key 不在 providers.json 中，而是在操作系统安全存储中；绝不要读取、改写或回显 provider-credentials.json，也不要向用户索要或让用户把 API Key 粘贴到对话。没有 Key 的新 Provider 必须由用户在 Esse 设置界面补录。',
    '外部编辑前先备份并校验 JSON，保留未知字段和其他 Provider，不要覆盖整份文件。外部编辑后必须提醒用户重启 Esse，让界面和后台统一重新加载；只有用户明确授权且 Agent 有本机进程权限时，Agent 才可以自行关闭并重新打开 Esse。不要在 Provider 请求运行中直接改配置。',
    '只查询配置文件不需要重启；普通图片生成不需要读取配置文件，继续使用 Esse 当前默认模型。',
  ].join('\n');
}
