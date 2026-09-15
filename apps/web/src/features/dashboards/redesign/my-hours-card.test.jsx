import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * My Hours card (spec Change 4). Asserts the exact title "My Hours", the default
 * This Week filter, all six period filters, an exact h/m/s display sourced from
 * the server response (never a browser timer), and the absence of any pay,
 * rate, earnings or dollar value.
 */
const getBcbaMyHours = vi.fn();
vi.mock('@/api/client', () => ({ getBcbaMyHours: (...a) => getBcbaMyHours(...a) }));

let host; let root; let MyHoursCard;

beforeEach(async () => {
  ({ MyHoursCard } = await import('./MyHoursCard.jsx'));
  getBcbaMyHours.mockReset();
  getBcbaMyHours.mockResolvedValue({ period: 'week', totalSeconds: 152258, hours: 42, minutes: 17, seconds: 38, text: '42h 17m 38s', sessionCount: 9 });
});
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><MyHoursCard /></QueryClientProvider>));
};
const waitFor = async (re) => { for (let i = 0; i < 80; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found in: ${host.textContent.slice(0, 300)}`); };

describe('MyHoursCard', () => {
  it('has the exact title "My Hours" and shows exact h/m/s from the server', async () => {
    mount();
    await waitFor(/42/);
    expect(host.textContent).toContain('My Hours');
    // hours, minutes, seconds all present
    expect(host.textContent).toMatch(/42h/);
    expect(host.textContent).toMatch(/17m/);
    expect(host.textContent).toMatch(/38s/);
  });

  it('defaults to This Week and offers exactly the six documented filters', async () => {
    mount();
    await waitFor(/42/);
    const tabs = [...host.querySelectorAll('.rx-segmented__item')].map((b) => b.textContent);
    expect(tabs).toEqual(['This Week', 'This Bi-Week', 'This Month', '3 Months', '6 Months', '1 Year']);
    const selected = host.querySelector('.rx-segmented__item.is-active');
    expect(selected.textContent).toBe('This Week');
    // first fetch used the default period
    expect(getBcbaMyHours).toHaveBeenCalledWith('week');
  });

  it('refetches real persisted time when the period changes', async () => {
    getBcbaMyHours.mockImplementation((p) => Promise.resolve(
      p === 'year'
        ? { period: 'year', hours: 900, minutes: 5, seconds: 2, sessionCount: 210 }
        : { period: 'week', hours: 42, minutes: 17, seconds: 38, sessionCount: 9 },
    ));
    mount();
    await waitFor(/42h/);
    const yearTab = [...host.querySelectorAll('.rx-segmented__item')].find((b) => b.textContent === '1 Year');
    await act(async () => { yearTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitFor(/900h/);
    expect(getBcbaMyHours).toHaveBeenCalledWith('year');
  });

  it('shows no payroll money, rate or earnings', async () => {
    mount();
    await waitFor(/42h/);
    const txt = host.textContent;
    expect(txt).not.toMatch(/\$/);
    expect(txt.toLowerCase()).not.toMatch(/payroll|earnings|salary|hourly rate|pay rate|\/hr/);
  });
});

describe('MyHoursCard — Monday → Sunday week', () => {
  it('shows the exact server week window as MM/DD/YYYY (org timezone, Monday to Sunday)', async () => {
    getBcbaMyHours.mockResolvedValue({
      period: 'week', hours: 2, minutes: 0, seconds: 0, sessionCount: 1, timeZone: 'America/New_York',
      from: '2026-09-07T04:00:00.000Z', to: '2026-09-14T04:00:00.000Z', weekStartsOn: 1,
    });
    mount();
    await waitFor(/09\/07\/2026/);
    expect(host.querySelector('[data-testid="my-hours-range"]').textContent).toContain('09/07/2026 – 09/13/2026');
    expect(host.textContent).not.toMatch(/2026-09-07/);
  });

  it('after the Monday rollover the new week starts from the server total (0h) with the new dates', async () => {
    getBcbaMyHours.mockResolvedValue({
      period: 'week', hours: 0, minutes: 0, seconds: 0, sessionCount: 0, timeZone: 'America/New_York',
      from: '2026-09-14T04:00:00.000Z', to: '2026-09-21T04:00:00.000Z', weekStartsOn: 1,
    });
    mount();
    await waitFor(/09\/14\/2026/);
    expect(host.querySelector('[data-testid="my-hours-range"]').textContent).toContain('09/14/2026 – 09/20/2026');
    expect(host.textContent).toMatch(/0\s*h/);
  });
});
