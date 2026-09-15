import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { StartSessionPanel } from './StartSessionPanel.jsx';
import { zonedWallTimeToUtc } from '@/lib/businessDate';

/**
 * Reported: on 09/14 the Start Session panel still offered
 * "Raymond K · 09/13/2026 · Start by 09/13/2026 11:59 PM".
 *
 * Root cause: the panel's clock was only re-read by ONE setTimeout aimed at the
 * next window boundary. Timers do not run while the machine sleeps (and run
 * late in background tabs), so a dashboard left open overnight kept judging
 * cards by 09/13's clock. These tests move the wall clock WITHOUT firing that
 * timeout, exactly like a sleep.
 */
vi.mock('@/auth/store', () => ({ useOrgTimezone: () => 'America/New_York' }));
const TZ = 'America/New_York';
const wall = (date, hh, mm = 0, ss = 0) => { const [y, m, d] = date.split('-').map(Number); return zonedWallTimeToUtc(y, m, d, hh, mm, ss, TZ); };

const card = (id, name, from, toExclusive) => ({
  appointmentId: id, clientId: `c-${id}`, childName: name, timeSet: false,
  startAt: wall(from, 0).toISOString(), endAt: wall(toExclusive, 0).toISOString(),
  sessionStatus: 'SCHEDULED', canStart: true, isRunning: false,
});
const SINGLE_0913 = card('a-13', 'Raymond K', '2026-09-13', '2026-09-14');
const RANGE_0912_0930 = card('a-range', 'Ada B', '2026-09-12', '2026-10-01');

let host; let root;
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); root = undefined; host = undefined; vi.useRealTimers(); });
const render = (cards) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<StartSessionPanel cards={cards} onStart={() => {}} />));
};
const fake = () => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
const labels = () => [...host.querySelectorAll('button')].filter((b) => /Start Session/i.test(b.textContent)).map((b) => b.getAttribute('aria-label'));

describe('Start Session panel — clock survives sleep / background tabs', () => {
  it('an expired 09/13 appointment is no longer startable after the machine sleeps past midnight', () => {
    fake();
    vi.setSystemTime(wall('2026-09-13', 15));
    render([SINGLE_0913]);
    expect(labels()).toEqual(['Start session with Raymond K']);

    // Sleep: the wall clock jumps to 09/14 09:00, no timer has fired.
    vi.setSystemTime(wall('2026-09-14', 9));
    act(() => { vi.advanceTimersByTime(30 * 1000); }); // first tick after wake
    expect(labels()).toEqual([]);
    expect(host.textContent).not.toContain('Ready to begin');
    expect(host.textContent).not.toContain('09/13/2026');
  });

  it('a multi-date booking rolls to the 09/14 occurrence after a sleep — never "09/13 · Start by 09/13 11:59 PM"', () => {
    fake();
    vi.setSystemTime(wall('2026-09-13', 15));
    render([RANGE_0912_0930]);
    expect(host.querySelector('.rx-row__meta').textContent).toBe('09/13/2026 · Start by 09/13/2026 11:59 PM');

    vi.setSystemTime(wall('2026-09-14', 9));
    act(() => { vi.advanceTimersByTime(30 * 1000); });
    expect(host.querySelector('.rx-row__meta').textContent).toBe('09/14/2026 · Start by 09/14/2026 11:59 PM');
    expect(host.textContent).not.toContain('09/13/2026');
  });

  it('re-reads the clock immediately when the tab becomes visible again', () => {
    fake();
    vi.setSystemTime(wall('2026-09-13', 15));
    render([SINGLE_0913, RANGE_0912_0930]);
    expect(labels().sort()).toEqual(['Start session with Ada B', 'Start session with Raymond K']);

    vi.setSystemTime(wall('2026-09-14', 9));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(labels()).toEqual(['Start session with Ada B']);
    expect(host.querySelector('.rx-row__meta').textContent).toBe('09/14/2026 · Start by 09/14/2026 11:59 PM');
  });

  it('new cards arriving (refetch) are judged by the real clock, not a stale one', () => {
    fake();
    vi.setSystemTime(wall('2026-09-13', 15));
    render([RANGE_0912_0930]);
    vi.setSystemTime(wall('2026-09-14', 9));
    act(() => root.render(<StartSessionPanel cards={[{ ...RANGE_0912_0930 }, { ...SINGLE_0913 }]} onStart={() => {}} />));
    expect(labels()).toEqual(['Start session with Ada B']);
  });

  it('does not re-render while no boundary has been crossed', () => {
    fake();
    vi.setSystemTime(wall('2026-09-14', 9));
    render([RANGE_0912_0930]);
    const before = host.querySelector('.rx-row__meta');
    act(() => { vi.advanceTimersByTime(5 * 60 * 1000); });
    expect(host.querySelector('.rx-row__meta')).toBe(before);
    expect(before.textContent).toBe('09/14/2026 · Start by 09/14/2026 11:59 PM');
  });
});
