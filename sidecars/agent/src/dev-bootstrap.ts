import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export async function configureWorkBuddyForDevelopment(options: {
  endpoint: string;
  pairingToken: string;
  configPath?: string;
}): Promise<void> {
  const configPath = options.configPath ?? path.join(os.homedir(), '.workbuddy', '.mcp.json');
  let config: Record<string, unknown> = {};
  let existed = false;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('WorkBuddy MCP config is not valid JSON; it was not modified.', { cause: error });
    }
  }

  const existingServers = config.mcpServers;
  if (existingServers !== undefined && (!existingServers || typeof existingServers !== 'object' || Array.isArray(existingServers))) {
    throw new Error('WorkBuddy MCP config has an invalid mcpServers value; it was not modified.');
  }
  const servers = { ...(existingServers as Record<string, unknown> | undefined) };
  const alreadyConfigured = Object.hasOwn(servers, 'esse');
  delete servers['esse-desktop'];
  servers.esse = {
    type: 'http',
    url: options.endpoint,
    headers: { Authorization: `Bearer ${options.pairingToken}` },
    description: 'Esse local image generation',
  };
  config.mcpServers = servers;

  await mkdir(path.dirname(configPath), { recursive: true });
  if (existed && !alreadyConfigured) {
    await copyFile(configPath, `${configPath}.pre-esse.bak`);
  }
  const temporary = `${configPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, configPath);
}
