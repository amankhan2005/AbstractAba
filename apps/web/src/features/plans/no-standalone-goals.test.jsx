import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ---------------------------------------------------------------------------
 * GOALS ARE PLAN CONTENT, NOT A PRODUCT AREA.
 *
 * The intended architecture is:
 *
 *     Treatment Plan
 *       └── goals / programs / targets
 *
 * NOT a standalone Goals section a clinician can navigate to. Goal DATA is
 * untouched and must keep working inside plans — this asserts only that there
 * is no standalone user-facing entry point.
 *
 * A repository-wide scan rather than a navigation check, so a future route,
 * card, button or link cannot quietly reintroduce the feature.
 * ---------------------------------------------------------------------------
 */

// this file lives at src/features/plans/, so src/ is three levels up
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

describe('no standalone Goals feature', () => {
  it('has no /goals route anywhere', () => {
    const offenders = files.filter((f) => /['"`]\/goals\b/.test(f.text) || /path:\s*['"`]goals\b/.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('has no Goals navigation item in any shell', () => {
    for (const f of files.filter((f) => f.path.startsWith('shells/'))) {
      expect(f.text, `${f.path} exposes Goals in navigation`).not.toMatch(/label:\s*['"`]Goals['"`]/);
    }
  });

  it('has no standalone Goals page component', () => {
    const pages = files.filter((f) => /GoalsPage|GoalsListPage|GoalsRedesign/.test(f.path));
    expect(pages.map((f) => f.path)).toEqual([]);
  });

  it('every goal API call is PLAN-SCOPED — there is no top-level goals endpoint', () => {
    const client = files.find((f) => f.path === 'api/client.js');
    const goalCalls = [...client.text.matchAll(/client\.\w+\(\s*`([^`]*goals[^`]*)`/g)].map((m) => m[1]);
    expect(goalCalls.length).toBeGreaterThan(0); // goal data is still reachable
    for (const url of goalCalls) {
      expect(url, `"${url}" is not plan-scoped`).toMatch(/\/v1\/plans\/\$\{[^}]+\}\/goals/);
      expect(url).not.toMatch(/\/v1\/goals/);
    }
  });

  it('goal content still lives inside the Treatment Plan UI', () => {
    // The inverse guarantee: removing the standalone feature must not have
    // removed goals from plans.
    const planDetail = files.find((f) => f.path === 'features/plans/PlanDetailPage.jsx');
    expect(planDetail, 'the plan detail page is missing').toBeTruthy();
    expect(planDetail.text).toMatch(/Goals/);
    expect(planDetail.text).toMatch(/updateGoal|archiveGoal/);
  });
});
