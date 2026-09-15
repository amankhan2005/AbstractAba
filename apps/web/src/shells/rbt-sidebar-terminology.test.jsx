import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, NavLink } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * ---------------------------------------------------------------------------
 * RBT SIDEBAR — professional US terminology, with routes untouched.
 *
 * The rail is already the RBT's own scoped view, so prefixing every row with
 * "My" added no information and read as translated rather than native. "My
 * children" in particular is wrong for a clinical product: the people on the
 * caseload are CLIENTS.
 *
 * The first test reads the real shell source, because the requirement is about
 * the exact words a user sees in the rail — asserting against a copy in the test
 * would let the two drift apart silently. The rest lock the ROUTES and the
 * active-state behaviour, which the rename must not disturb.
 * ---------------------------------------------------------------------------
 */

const here = dirname(fileURLToPath(import.meta.url));
const shellSource = readFileSync(join(here, 'RbtShell.jsx'), 'utf8');

/** The nav item labels declared in the real RbtShell NAV, in source order. */
function navLabels() {
  const nav = shellSource.slice(shellSource.indexOf('const NAV = ['), shellSource.indexOf('function greeting'));
  return [...nav.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
}
/** The { to, label } pairs declared in the real RbtShell NAV. */
function navItems() {
  const nav = shellSource.slice(shellSource.indexOf('const NAV = ['), shellSource.indexOf('function greeting'));
  return [...nav.matchAll(/\{\s*to:\s*'([^']+)',\s*label:\s*'([^']+)'/g)].map((m) => ({ to: m[1], label: m[2] }));
}

describe('RBT sidebar terminology', () => {
  it('uses exactly the required labels', () => {
    const labels = navLabels();
    for (const required of ['Dashboard', 'Sessions', 'Schedule', 'Clients', 'Programs']) {
      expect(labels, `sidebar is missing "${required}"`).toContain(required);
    }
  });

  it('contains no "My ..." labels at all', () => {
    for (const label of navLabels()) {
      expect(label, `sidebar still says "${label}"`).not.toMatch(/^My\b/i);
    }
  });

  it('exposes the Manual Session entry point at the canonical /sessions/manual route', () => {
    const nav = navItems();
    expect(nav.filter((i) => /manual/i.test(i.label))).toEqual([{ to: '/sessions/manual', label: 'Manual Session' }]);
  });

  it('never calls the caseload "children" anywhere in the rail', () => {
    expect(navLabels().join(' ').toLowerCase()).not.toContain('children');
  });

  it('keeps the canonical routes — this was a label change, not a routing change', () => {
    const byLabel = Object.fromEntries(navItems().map((i) => [i.label, i.to]));
    expect(byLabel.Dashboard).toBe('/dashboards/rbt');
    expect(byLabel.Sessions).toBe('/sessions');
    expect(byLabel.Schedule).toBe('/scheduling');
    expect(byLabel.Clients).toBe('/clients');
    expect(byLabel.Programs).toBe('/plans');
  });
});

// --- active navigation state -------------------------------------------------

let host; let root;
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

function renderAt(path) {
  const items = navItems();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(
    <MemoryRouter initialEntries={[path]}>
      {items.map((it) => (
        // `end` mirrors ShellFrame: /sessions is a prefix of /sessions/manual,
        // so the parent row must not stay lit on the child route.
        <NavLink
          key={it.to}
          to={it.to}
          end={it.to === '/sessions'}
          className={({ isActive }) => `rx-nav__link${isActive ? ' is-active' : ''}`}
        >
          {it.label}
        </NavLink>
      ))}
    </MemoryRouter>,
  ));
  return [...host.querySelectorAll('.rx-nav__link.is-active')].map((n) => n.textContent);
}

describe('RBT sidebar active state', () => {
  it('lights exactly one row on each canonical route', () => {
    expect(renderAt('/dashboards/rbt')).toEqual(['Dashboard']);
    expect(renderAt('/sessions')).toEqual(['Sessions']);
    expect(renderAt('/scheduling')).toEqual(['Schedule']);
    expect(renderAt('/clients')).toEqual(['Clients']);
    expect(renderAt('/plans')).toEqual(['Programs']);
  });

  it('lights exactly one row on a nested session route — no double-active', () => {
    // /sessions is a prefix of /sessions/panel, so without `end` the parent row
    // would glow alongside the child route.
    expect(renderAt('/sessions/panel')).toEqual([]);
    expect(renderAt('/sessions')).toEqual(['Sessions']);
  });

  it('lights the parent row on a nested client route', () => {
    expect(renderAt('/clients/abc123')).toEqual(['Clients']);
  });
});
