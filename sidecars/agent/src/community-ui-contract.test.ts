import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname);
const renderer = fs.readFileSync(path.join(sourceRoot, 'renderer.tsx'), 'utf8');

describe('Esse Community UI contract', () => {
  it('opens directly without the commercial onboarding flow', () => {
    expect(renderer).not.toContain('shouldShowOnboarding');
    expect(renderer).not.toContain('onboarding-screen');
    expect(renderer).not.toContain('Esse Key');
  });

  it('keeps the original Provider-first settings', () => {
    expect(renderer).toContain('TUZI_PROVIDER_PRESETS');
    expect(renderer).toContain('createTuziProviderDraft');
    expect(renderer).toContain('default-model-panel');
    expect(renderer).toContain('mcp-settings');
  });
});
