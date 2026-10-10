import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { AUTHORIZED_WORKFLOW_POLICY, WORKFLOW_POLLING } from './workflow-policy';
import { DESKTOP_BATCH_SKILL } from './desktop-skill';

it('keeps runtime instructions, packaged skills and the independent Plugin policy consistent', async () => {
  for (const resource of ['../skills/batch-generate-images/SKILL.md', '../../../plugins/codex/skills/batch-generate-images/SKILL.md']) {
    const text = await readFile(new URL(resource, import.meta.url), 'utf8');
    expect(text.split('## Authorized continuation\n\n')[1]?.trim()).toBe(AUTHORIZED_WORKFLOW_POLICY);
    expect(text).not.toMatch(/later user message|end the current task immediately|do not poll, monitor, or follow up|automatically up to three times/);
  }
  const plugin = await readFile(new URL('../../../plugins/codex/src/mcp/workflow-policy.ts', import.meta.url), 'utf8');
  const policyLiteral = plugin.match(/AUTHORIZED_WORKFLOW_POLICY = (".*");/)?.[1];
  expect(policyLiteral && JSON.parse(policyLiteral)).toBe(AUTHORIZED_WORKFLOW_POLICY);
  expect(DESKTOP_BATCH_SKILL).toContain(AUTHORIZED_WORKFLOW_POLICY);
  expect(DESKTOP_BATCH_SKILL).not.toMatch(/later user message|end the current task immediately|Acceptance is the terminal success/);
  expect(AUTHORIZED_WORKFLOW_POLICY).toContain('A submit-only request may end after handoff');
  expect(AUTHORIZED_WORKFLOW_POLICY).toContain('no new user message is required');
  expect(AUTHORIZED_WORKFLOW_POLICY).toContain("Respect the client's actual Plan mode");
  expect(AUTHORIZED_WORKFLOW_POLICY).toContain('never automatic resubmission');
  expect(AUTHORIZED_WORKFLOW_POLICY).toContain('original model, references, targets, quantity, budget, and attempt limit');
  expect(WORKFLOW_POLLING).toEqual({ minIntervalMs: 5000, maxIntervalMs: 30000, timeoutMs: 900000 });
});
