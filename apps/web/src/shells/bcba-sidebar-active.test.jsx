import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, NavLink } from 'react-router-dom';

/**
 * Sidebar double-active bug (spec §8): the BCBA nav has "Review queue" → /sessions
 * and "Session panel" → /sessions/panel. Because /sessions is a path prefix of
 * /sessions/panel, a NavLink to /sessions WITHOUT `end` stays active on
 * /sessions/panel — so two items glow at once. The fix is `end: true` on the
 * Review-queue item. These tests lock the exclusive behaviour the fix depends on.
 */

// Mirror of the real BCBA nav items involved in the collision.
const ITEMS = [
  { to: '/sessions', label: 'Review Queue', end: true, activeFor: ['/sessions/:sessionId'] },
  { to: '/sessions/panel', label: 'Session Panel' },
];

let host; let root;
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

function renderAt(path) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(
    <MemoryRouter initialEntries={[path]}>
      {ITEMS.map((it) => (
        <NavLink key={it.to} to={it.to} end={it.end}
          className={({ isActive }) => `rx-nav__link${isActive ? ' is-active' : ''}`}>
          {it.label}
        </NavLink>
      ))}
    </MemoryRouter>,
  ));
  return [...host.querySelectorAll('.rx-nav__link.is-active')].map((n) => n.textContent);
}

describe('BCBA sidebar active state is mutually exclusive', () => {
  it('on /sessions/panel only "Session Panel" is active', () => {
    const active = renderAt('/sessions/panel');
    expect(active).toEqual(['Session Panel']);
  });
  it('on /sessions only "Review Queue" is active', () => {
    const active = renderAt('/sessions');
    expect(active).toEqual(['Review Queue']);
  });
});
