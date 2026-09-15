import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Part 2 — the "Session oversight" sidebar item showed a persistent blue focus
 * glow after a mouse click. Root cause: nav links had no :focus rule, so the
 * browser's default focus outline stuck after a pointer click. Fix: suppress
 * the ring for pointer focus (:focus { outline:none }) while keeping an
 * accessible KEYBOARD ring (:focus-visible). This asserts the CSS contract so
 * the fix can't silently regress; it also guards that focus isn't disabled
 * globally (accessibility preserved).
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../styles/redesign.css'), 'utf8');

describe('sidebar nav focus', () => {
  it('suppresses the pointer-focus outline on nav links', () => {
    expect(css).toMatch(/\.rx-nav__link:focus\s*\{\s*outline:\s*none/);
  });

  it('keeps a visible KEYBOARD focus ring via :focus-visible', () => {
    expect(css).toMatch(/\.rx-nav__link:focus-visible\s*\{[^}]*outline:/);
  });

  it('does not disable focus outlines globally (accessibility preserved)', () => {
    // No blanket "*:focus { outline: none }" or "* { outline: none }" rule.
    expect(css).not.toMatch(/\*\s*:?focus[^{]*\{\s*outline:\s*none/);
    expect(css).not.toMatch(/^\s*\*\s*\{\s*outline:\s*none/m);
  });
});
