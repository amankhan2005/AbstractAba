import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ---------------------------------------------------------------------------
 * LIST REQUESTS MUST RESPECT THE SERVER'S PAGE-SIZE BOUND.
 *
 * The reported 422s on /api/v1/clients?limit=200 and /api/v1/staff?limit=200
 * were a real application bug, not a test artifact: both schemas declare
 * `limit: z.coerce.number().int().min(1).max(100)`, so a request for 200 is
 * rejected outright. Both name-lookup queries therefore failed on every session
 * screen, and every client name fell back to the neutral placeholder "Child"
 * with nothing on screen to explain it.
 *
 * The cap is a deliberate server bound, so the client respects it. This scan
 * fails if any request reintroduces an over-limit page size.
 * ---------------------------------------------------------------------------
 */

const src = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SERVER_MAX_PAGE = 100;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (/\.(js|jsx)$/.test(entry) && !/\.test\.(js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(src).map((f) => ({ path: relative(src, f), text: readFileSync(f, 'utf8') }));

describe('paged list requests', () => {
  it('never asks for more rows than the server accepts', () => {
    const offenders = [];
    for (const f of files) {
      for (const m of f.text.matchAll(/limit:\s*(\d+)/g)) {
        const value = Number(m[1]);
        if (value > SERVER_MAX_PAGE) offenders.push(`${f.path} → limit: ${value}`);
      }
    }
    expect(offenders, `these requests would be rejected with 422:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the session name lookups request exactly the server maximum', () => {
    const hook = files.find((f) => f.path === 'features/sessions/useBcbaSession.js');
    expect(hook).toBeTruthy();
    expect(hook.text).toMatch(/MAX_NAME_PAGE\s*=\s*100/);
    expect(hook.text).toMatch(/listClients\(\{\s*limit:\s*MAX_NAME_PAGE\s*\}\)/);
    expect(hook.text).toMatch(/listStaff\(\{\s*limit:\s*MAX_NAME_PAGE\s*\}\)/);
  });
});
