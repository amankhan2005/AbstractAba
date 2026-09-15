import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Token coverage — BR-UI-1. Component and theme source must resolve every visual
 * value through a token; a hardcoded hex colour or pixel size is a defect. This
 * scan fails the build when one appears. The stylesheet and the shared contract
 * are the sanctioned homes for literal values and are not scanned; the parity
 * test keeps those two in agreement. Ported verbatim (scans .js/.jsx).
 */
const here = dirname(fileURLToPath(import.meta.url));
const roots = [join(here, '.'), join(here, '..', 'components')];

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const PX = /\b\d+px\b/;

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.jsx?$/.test(entry) && !/\.test\.jsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('token coverage', () => {
  const files = roots.flatMap(sourceFiles);
  it('scans a non-trivial number of component and theme files', () => {
    expect(files.length).toBeGreaterThan(5);
  });
  it('contains no hardcoded hex colour in component or theme source', () => {
    const offenders = files.filter((file) => HEX.test(readFileSync(file, 'utf8')));
    expect(offenders, `hardcoded hex in: ${offenders.join(', ')}`).toEqual([]);
  });
  it('contains no hardcoded pixel size in component or theme source', () => {
    const offenders = files.filter((file) => PX.test(readFileSync(file, 'utf8')));
    expect(offenders, `hardcoded px in: ${offenders.join(', ')}`).toEqual([]);
  });
});
