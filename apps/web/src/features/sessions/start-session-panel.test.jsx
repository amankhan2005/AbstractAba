import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { StartSessionPanel } from './StartSessionPanel.jsx';
import { zonedWallTimeToUtc } from '@/lib/businessDate';

/**
 * START SESSION near the top of both clinician dashboards.
 *
 * Not a second session-creation path: the panel renders the panel cards the
 * dashboard already holds and calls the SAME start mutation the session list
 * uses. These tests pin WHICH appointments it offers, because offering one the
 * server would refuse is worse than not offering it at all.
 */
vi.mock('@/auth/store', () => ({ useOrgTimezone: () => 'America/New_York' }));

let host; let root;
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const render = (props) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<StartSessionPanel onStart={() => {}} {...props} />));
  return host;
};
const buttons = () => [...host.querySelectorAll('button')].filter((b) => /Start Session/i.test(b.textContent));

/** Org midnight for today in New York, so the card is genuinely startable now. */
function todayCard(overrides = {}) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  return {
    appointmentId: 'appt-1', clientId: 'c1', childName: 'Raymond K',
    startAt: start.toISOString(), endAt: end.toISOString(), timeSet: false,
    canStart: true, isRunning: false, ...overrides,
  };
}

describe('StartSessionPanel', () => {
  it('offers a single startable appointment prominently', () => {
    render({ cards: [todayCard()] });
    expect(buttons().length).toBe(1);
    expect(host.textContent).toMatch(/Start a session/i);
    expect(host.textContent).toMatch(/Raymond K/);
  });

  it('lists ALL startable appointments rather than picking one arbitrarily', () => {
    render({ cards: [todayCard(), todayCard({ appointmentId: 'appt-2', childName: 'Ada Byron' })] });
    expect(buttons().length).toBe(2);
    expect(host.textContent).toMatch(/Raymond K/);
    expect(host.textContent).toMatch(/Ada Byron/);
    expect(host.textContent).toMatch(/2 available/);
  });

  it('calls the existing start flow with the real appointment id', () => {
    const onStart = vi.fn();
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root.render(<StartSessionPanel cards={[todayCard()]} onStart={onStart} />));
    act(() => { buttons()[0].click(); });
    expect(onStart).toHaveBeenCalledWith('appt-1');
  });

  it('does NOT offer an appointment the server marks unstartable', () => {
    render({ cards: [todayCard({ canStart: false })] });
    expect(buttons().length).toBe(0);
  });

  it('does NOT offer an appointment whose 24-hour start window has closed', () => {
    // Started 72h ago: canStart is still true (lifecycle), but its start window
    // closed long ago — the server would refuse with APPOINTMENT_NOT_TODAY.
    const y = new Date(Date.now() - 72 * 3.6e6);
    render({ cards: [todayCard({
      startAt: y.toISOString(), endAt: new Date(y.getTime() + 2 * 3.6e6).toISOString(), timeSet: true,
    })] });
    expect(buttons().length).toBe(0);
    expect(host.textContent).toMatch(/Nothing to start right now/i);
  });

  it('hides itself entirely while a session is running', () => {
    render({ cards: [todayCard()], hasRunning: true });
    expect(host.textContent).toBe('');
  });

  it('renders nothing at all when the clinician has no assignments — never a fake appointment', () => {
    render({ cards: [] });
    expect(host.textContent).toBe('');
  });

  it('shows the date in US format', () => {
    const card = todayCard();
    render({ cards: [card] });
    expect(host.textContent).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(host.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('StartSessionPanel — strict 24-hour start windows', () => {
  const NY = 'America/New_York';
  const wall = (date, hh, mm = 0, ss = 0) => { const [y, m, d] = date.split('-').map(Number); return zonedWallTimeToUtc(y, m, d, hh, mm, ss, NY); };
  const at10 = (date, id, childName) => ({
    appointmentId: id, clientId: 'c1', childName, canStart: true, isRunning: false, timeSet: true,
    startAt: wall(date, 10).toISOString(), endAt: wall(date, 11).toISOString(),
  });
  const cards = [at10('2026-09-12', 'a12', 'Child Twelve'), at10('2026-09-13', 'a13', 'Child Thirteen'), at10('2026-09-14', 'a14', 'Child Fourteen')];
  afterEach(() => { vi.useRealTimers(); });

  it('lists ONLY appointments whose window is open now — not by calendar date', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(wall('2026-09-13', 9));          // 09/12 10 AM window still open; 09/13 not yet
    render({ cards });
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Start session with Child Twelve']);
    expect(host.textContent).toContain('Start by 09/13/2026 9:59 AM');
    expect(host.textContent).not.toMatch(/Child Thirteen|Child Fourteen/);
  });

  it('removes the expired appointment and shows the next one EXACTLY when the windows turn over (no reload)', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(wall('2026-09-13', 9, 59, 30));
    render({ cards });
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Start session with Child Twelve']);
    act(() => { vi.advanceTimersByTime(29 * 1000); });  // 09:59:59 — still the 09/12 window
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Start session with Child Twelve']);
    act(() => { vi.advanceTimersByTime(2 * 1000); });   // 10:00:01 — 09/12 expired, 09/13 open
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Start session with Child Thirteen']);
    expect(host.textContent).not.toMatch(/Child Twelve|Child Fourteen/);
  });

  it('a 7:00 PM appointment is still offered at 6:30 PM the next day and gone at 7:01 PM', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const seven = { appointmentId: 'p7', clientId: 'c1', childName: 'Evening Child', canStart: true, isRunning: false, timeSet: true,
      startAt: wall('2026-09-12', 19).toISOString(), endAt: wall('2026-09-12', 20).toISOString() };
    vi.setSystemTime(wall('2026-09-13', 18, 30));
    render({ cards: [seven] });
    expect(buttons().length).toBe(1);
    act(() => { vi.advanceTimersByTime(31 * 60 * 1000); }); // 7:01 PM
    expect(buttons().length).toBe(0);
    expect(host.textContent).toMatch(/Nothing to start right now/i);
  });
});
