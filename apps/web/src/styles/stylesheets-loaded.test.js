import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

/**
 * ---------------------------------------------------------------------------
 * EVERY STYLESHEET MUST BE IMPORTED.
 *
 * Found by running the dev server and reading the served CSS rather than by
 * reading the code: `main.jsx` imported only `styles/global.css`, while the
 * rules for insurance, guardian invitations, care-team assignment and company
 * branding had all been appended to `styles/index.css` — a file nothing
 * imported. Those pages rendered with no styling at all.
 *
 * Nothing catches this. The build succeeds, every unit test passes, and the
 * components render correctly in jsdom because jsdom does not apply CSS. Only
 * looking at the page reveals it, and the failure is silent everywhere else —
 * which is exactly why it is worth a test.
 *
 * The check is deliberately about REACHABILITY, not content: a stylesheet in
 * the tree that nothing imports is either dead or a mistake, and both are
 * worth knowing about.
 * ---------------------------------------------------------------------------
 */

function cssFiles() {
  return readdirSync(join(srcRoot, 'styles'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `styles/${f}`);
}

function allImportedCss() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(jsx?|tsx?)$/.test(entry.name)) continue;
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/import\s+['"]([^'"]+\.css)['"]/g)) {
        found.add(match[1].replace(/^\.\//, ''));
      }
    }
  };
  walk(srcRoot);
  return found;
}

describe('stylesheet reachability', () => {
  it('every stylesheet in styles/ is imported by some module', () => {
    const imported = allImportedCss();
    const orphans = cssFiles().filter((file) => ![...imported].some((i) => i.endsWith(file)));
    expect(orphans, `These stylesheets are never imported, so their rules never load: ${orphans.join(', ')}`)
      .toEqual([]);
  });

  it('main.jsx loads global.css before the feature styles that depend on it', () => {
    // index.css uses the custom properties (--color-*, --space-*) that
    // global.css defines. Loading it first would not break the cascade, but the
    // ordering states the dependency where a reader will see it.
    const main = readFileSync(join(srcRoot, 'main.jsx'), 'utf8');
    const globalAt = main.indexOf("styles/global.css");
    const indexAt = main.indexOf("styles/index.css");
    expect(globalAt, 'global.css must be imported by main.jsx').toBeGreaterThan(-1);
    expect(indexAt, 'index.css must be imported by main.jsx').toBeGreaterThan(-1);
    expect(globalAt).toBeLessThan(indexAt);
  });

  it('the feature stylesheet actually carries the rules the new pages reference', () => {
    // A spot check that the file has not been emptied or replaced: each of
    // these classes is used by a page added in a recent pass.
    const css = readFileSync(join(srcRoot, 'styles', 'index.css'), 'utf8');
    for (const selector of ['.ins-head', '.guardian__card', '.brand-logo', '.guardian-invite']) {
      expect(css, `${selector} is missing from the feature stylesheet`).toContain(selector);
    }
  });
});
