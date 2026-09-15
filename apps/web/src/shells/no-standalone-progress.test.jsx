import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Fix 3 — the STANDALONE "Progress" page must not appear in staff navigation.
 * Progress stays CONTEXTUAL (Child → Progress tab; Session → data), which the
 * spec requires us to keep. This guards against a standalone Progress nav item
 * being (re)introduced into any staff shell, and confirms the contextual tab and
 * ProgressPanel still exist.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

describe('staff navigation — no standalone Progress (Fix 3)', () => {
  for (const shell of ['CompanyShell.jsx', 'BcbaShell.jsx', 'RbtShell.jsx']) {
    it(`${shell} has no standalone Progress nav item`, () => {
      const src = read(`./${shell}`);
      // a nav item is `{ to: '/...', label: 'X', icon: ... }` — assert no nav
      // label is exactly "Progress" and there is no /progress route link.
      expect(src).not.toMatch(/label:\s*['"]Progress['"]/);
      expect(src).not.toMatch(/to:\s*['"]\/progress['"]/);
    });
  }

  it('contextual progress is preserved (child-detail Progress tab + ProgressPanel exist)', () => {
    const bcbaChild = read('../features/clients/redesign/BcbaChildView.jsx');
    // the contextual child tab remains
    expect(bcbaChild).toMatch(/id:\s*'progress'/);
    // and the panel it renders still exists
    expect(() => read('../features/clients/redesign/ProgressPanel.jsx')).not.toThrow();
  });
});
