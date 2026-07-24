import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(import.meta.dirname, 'index.css'), 'utf8');
const renderer = fs.readFileSync(path.resolve(import.meta.dirname, 'renderer.tsx'), 'utf8');
const selectMenu = fs.readFileSync(path.resolve(import.meta.dirname, 'select-menu.tsx'), 'utf8');

describe('desktop control styling', () => {
  it('does not expose native select menus in the renderer', () => {
    expect(renderer).not.toMatch(/<select\b/);
    expect(renderer).toMatch(/<SelectMenu\b/);
  });

  it('uses an accessible listbox contract for custom menus', () => {
    expect(selectMenu).toMatch(/aria-haspopup="listbox"/);
    expect(selectMenu).toMatch(/role="listbox"/);
    expect(selectMenu).toMatch(/role="option"/);
    expect(selectMenu).toMatch(/aria-selected=/);
  });

  it('keeps composite inputs to a single visible focus ring', () => {
    expect(css).toMatch(/\.library-search:focus-within[^}]*\{[^}]*box-shadow:\s*var\(--focus-ring\)/);
    expect(css).toMatch(/\.library-search input:focus\s*\{[^}]*box-shadow:\s*none/);
    expect(css).toMatch(/\.modify-composer textarea:focus\s*\{[^}]*box-shadow:\s*none/);
  });
});
