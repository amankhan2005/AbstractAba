import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ---------------------------------------------------------------------------
 * MANUAL SESSION NAVIGATION — BCBA & RBT.
 *
 * Manual Session is a first-class page in BOTH clinician rails, at the one
 * canonical route /sessions/manual. It stays a SEPARATE workflow: only the
 * dedicated page calls the manual-session endpoints, and the normal Start
 * Session flow (dashboards / session panel) never does — the scheduled
 * appointment start still goes through /appointments/:id/start.
 *
 * Scans the real source tree (no browser in this environment).
 * ---------------------------------------------------------------------------
 */
const src = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (/\.(js|jsx)$/.test(entry) && !/\.test\.(js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}
const files = walk(src).map((f) => ({ path: relative(src, f), text: readFileSync(f, 'utf8') }));
const file = (p) => files.find((f) => f.path === p);

const ALLOWED_CALLERS = ['api/client.js', 'features/sessions/ManualSessionPage.jsx', 'app/routes.jsx'];

describe('Manual Session navigation', () => {
  it('BCBA and RBT rails both link "Manual Session" to /sessions/manual', () => {
    for (const shell of ['shells/BcbaShell.jsx', 'shells/RbtShell.jsx']) {
      expect(file(shell).text, shell).toMatch(/\{\s*to:\s*'\/sessions\/manual',\s*label:\s*'Manual Session'/);
    }
  });

  it('the Company Admin rail does not offer Manual Session', () => {
    expect(file('shells/CompanyShell.jsx').text).not.toMatch(/sessions\/manual|Manual Session/);
  });

  it('the route exists once and renders the dedicated page', () => {
    const routes = file('app/routes.jsx').text;
    expect(routes.match(/path: 'sessions\/manual'/g)).toHaveLength(1);
    expect(routes).toMatch(/path: 'sessions\/manual', element: <ManualSessionPage \/>/);
  });

  it('only the dedicated page calls the manual-session endpoints', () => {
    const callers = files
      .filter((f) => /createRbtManualSession|createBcbaManualSession|manual-session/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !ALLOWED_CALLERS.includes(p));
    expect(callers, `unexpected manual-session callers: ${callers.join(', ')}`).toEqual([]);
  });

  it('the normal Start Session flow still uses the scheduled-appointment endpoints', () => {
    const rbt = file('features/dashboards/redesign/RbtDashboardPage.jsx');
    expect(rbt.text).toMatch(/startRbtSession/);
    expect(rbt.text).not.toMatch(/ManualSession/);
    expect(file('features/sessions/bcbaSessionUi.jsx').text).toMatch(/startBcbaSession/);
  });
});
