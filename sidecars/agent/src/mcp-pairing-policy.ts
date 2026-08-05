import { randomBytes } from 'node:crypto';

interface SessionPairingTokenOptions {
  ephemeral: boolean;
  persistent: () => Promise<string>;
  randomToken?: () => string;
}

export async function resolveSessionPairingToken(options: SessionPairingTokenOptions): Promise<string> {
  if (options.ephemeral) return (options.randomToken ?? createRandomToken)();
  return options.persistent();
}

function createRandomToken(): string {
  return randomBytes(32).toString('base64url');
}
