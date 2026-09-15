import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { StartSessionPanel } from './StartSessionPanel.jsx';
import { zonedWallTimeToUtc } from '@/lib/businessDate';
import { appointmentOccurrence, occurrenceText, startabilityLabel, groupSessionCards } from '@/lib/appointment';

/**
 * MULTI-DATE appointment 09/12/2026 → 09/30/2026 (date-only, org timezone
 * America/New_York). Each scheduled date is its own occurrence: on 09/13 the
 * Start Session panel must represent 09/13 — never 09/12, never the range.
 */
vi.mock('@/auth/store', () => ({ useOrgTimezone: () => 'America/New_York' }));
const TZ = 'America/New_York';
const wall = (date, hh, mm = 0, ss = 0) => { const [y, m, d] = date.split('-').map(Number); return zonedWallTimeToUtc(y, m, d, hh, mm, ss, TZ); };

const RANGE_CARD = {
  appointmentId: 'appt-range', clientId: 'c1', childName: 'Raymond K', timeSet: false,
  startAt: wall('2026-09-12', 0).toISOString(), endAt: wall('2026-10-01', 0).toISOString(),
  sessionStatus: 'SCHEDULED', canStart: true, isRunning: false,
};

let host; let root;
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); root = undefined; host = undefined; vi.useRealTimers(); });
const render = (cards) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<StartSessionPanel cards={cards} onStart={() => {}} />));
};
const startButtons = () => [...host.querySelectorAll('button')].filter((b) => /Start Session/i.test(b.textContent));

describe('multi-date appointment — occurrence per business date', () => {
  it('on 09/13 the occurrence is 09/13: 09/12 expired, 09/14 future', () => {
    const now = wall('2026-09-13', 10);
    const occ = appointmentOccurrence(RANGE_CARD, TZ, now);
    expect(occ.status).toBe('AVAILABLE');
    expect(occ.businessDate).toBe('2026-09-13');
    expect(appointmentOccurrence({ ...RANGE_CARD, sessionStatus: 'STOPPED', sessionBusinessDate: '2026-09-12' }, TZ, now).status).toBe('EXPIRED');
    expect(occurrenceText(RANGE_CARD, TZ, now)).toBe('09/13/2026');
    expect(occurrenceText(RANGE_CARD, TZ, wall('2026-09-14', 1))).toBe('09/14/2026');
  });

  it('Start Session panel on 09/13 shows the 09/13 occurrence — not "09/12/2026 … Start by 09/13/2026 11:59 PM"', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(wall('2026-09-13', 10));
    render([RANGE_CARD]);
    expect(startButtons()).toHaveLength(1);
    const meta = host.querySelector('.rx-row__meta').textContent;
    expect(meta).toBe('09/13/2026 · Start by 09/13/2026 11:59 PM');
    expect(host.textContent).not.toContain('09/12/2026');
    expect(host.textContent).not.toMatch(/09\/30\/2026|–/); // not the whole range
  });

  it('a STOPPED session from 09/12 is not offered on 09/13 (its own occurrence expired)', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(wall('2026-09-13', 10));
    render([{ ...RANGE_CARD, sessionStatus: 'STOPPED', sessionBusinessDate: '2026-09-12', startStatus: 'EXPIRED', expired: true, canResume: true }]);
    expect(startButtons()).toHaveLength(0);
    expect(host.textContent).not.toMatch(/Start by 09\/13\/2026 11:59 PM/);
    expect(startabilityLabel({ ...RANGE_CARD, sessionStatus: 'STOPPED', sessionBusinessDate: '2026-09-12', startStatus: 'EXPIRED' }, TZ, wall('2026-09-13', 10)))
      .toBe('Expired — start window closed 09/13/2026 12:00 AM');
  });

  it('rolls to the next occurrence exactly at midnight (09/13 → 09/14) without a reload', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(wall('2026-09-13', 23, 59, 50));
    render([RANGE_CARD]);
    expect(host.querySelector('.rx-row__meta').textContent).toBe('09/13/2026 · Start by 09/13/2026 11:59 PM');
    act(() => { vi.advanceTimersByTime(15 * 1000); });            // 00:00:05 on 09/14
    expect(host.querySelector('.rx-row__meta').textContent).toBe('09/14/2026 · Start by 09/14/2026 11:59 PM');
    expect(host.textContent).not.toContain('09/13/2026');
  });

  it('09/30 becomes eligible only on 09/30; after it the appointment is expired and gone', () => {
    const on29 = appointmentOccurrence(RANGE_CARD, TZ, wall('2026-09-29', 12));
    expect(on29.businessDate).toBe('2026-09-29');
    const on30 = appointmentOccurrence(RANGE_CARD, TZ, wall('2026-09-30', 0));
    expect([on30.status, on30.businessDate]).toEqual(['AVAILABLE', '2026-09-30']);
    const after = groupSessionCards([RANGE_CARD], TZ, wall('2026-10-01', 0));
    expect(after.expired).toHaveLength(1);
    expect(after.current).toHaveLength(0);
  });

  it('lists ALL valid appointments for today — a same-day booking and the range occurrence', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(wall('2026-09-13', 10));
    const single = { ...RANGE_CARD, appointmentId: 'appt-single', childName: 'Ada B', startAt: wall('2026-09-13', 0).toISOString(), endAt: wall('2026-09-14', 0).toISOString() };
    const yesterdayOnly = { ...RANGE_CARD, appointmentId: 'appt-y', childName: 'Old Booking', startAt: wall('2026-09-12', 0).toISOString(), endAt: wall('2026-09-13', 0).toISOString() };
    render([RANGE_CARD, single, yesterdayOnly]);
    expect(startButtons().map((b) => b.getAttribute('aria-label')).sort()).toEqual(['Start session with Ada B', 'Start session with Raymond K']);
    expect(host.textContent).not.toMatch(/Old Booking/);
  });
});
