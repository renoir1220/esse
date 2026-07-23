import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname);
const renderer = fs.readFileSync(path.join(sourceRoot, 'renderer.tsx'), 'utf8');
const preload = fs.readFileSync(path.join(sourceRoot, 'preload.ts'), 'utf8');
const main = fs.readFileSync(path.join(sourceRoot, 'main.ts'), 'utf8');

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

  it('copies exact batch and image references through the native clipboard bridge', () => {
    expect(renderer).toContain('className="batch-reference-copy"');
    expect(renderer).toContain('复制批次名称和 ID');
    expect(renderer).toContain('复制图片 ID');
    expect(preload).toContain("'references:copy-batch'");
    expect(preload).toContain("'references:copy-image-id'");
    expect(main).toContain("clipboard.writeText(batchReferenceText(batch.title, batch.id))");
    expect(main).toContain("clipboard.writeText(imageIdReferenceText(id))");
  });
});
