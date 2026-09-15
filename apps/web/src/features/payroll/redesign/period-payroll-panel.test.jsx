import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * Company Admin · Payroll page. Payroll Period (Weekly / Bi-weekly / Custom) →
 * the server's payroll for that period (actual worked hours × each staff member's
 * hourly rate) → Generate Payroll → Generated Payroll → Download Excel / PDF.
 * The page renders only what the server returns.
 */
const previewPeriodPayroll = vi.fn();
const getGeneratedPeriodPayroll = vi.fn();
const generatePeriodPayroll = vi.fn();
const downloadPeriodPayrollXlsx = vi.fn(() => Promise.resolve('payroll.xlsx'));
const downloadPeriodPayrollPdf = vi.fn(() => Promise.resolve('payroll.pdf'));
vi.mock('@/api/client', () => ({
  previewPeriodPayroll: (...a) => previewPeriodPayroll(...a),
  getGeneratedPeriodPayroll: (...a) => getGeneratedPeriodPayroll(...a),
  generatePeriodPayroll: (...a) => generatePeriodPayroll(...a),
  downloadPeriodPayrollXlsx: (...a) => downloadPeriodPayrollXlsx(...a),
  downloadPeriodPayrollPdf: (...a) => downloadPeriodPayrollPdf(...a),
}));
const toasts = [];
vi.mock('@/components', () => ({ useToast: () => ({ push: (m) => toasts.push(m) }) }));
vi.mock('@/auth/store', () => ({ useOrgTimezone: () => 'America/New_York' }));

const periodOf = (mode, from, to, previousAnchor = null, nextAnchor = null) => ({
  mode, from, to, label: `${from.slice(5, 7)}/${from.slice(8)}/${from.slice(0, 4)} – ${to.slice(5, 7)}/${to.slice(8)}/${to.slice(0, 4)}`, previousAnchor, nextAnchor,
});
const staff = (id, name, role, rates, minutes, amount, extra = {}) => ({ staffProfileId: id, staffName: name, role, hourlyRates: rates, hourlyRate: rates.length === 1 ? rates[0] : null, workedMinutes: minutes, amount, missingRate: false, ...extra });
/** Test1 J BCBA $50/hr 6h 00m = $300.00; Test2 K RBT $25/hr 2h 30m = $62.50; total $362.50. */
const PREVIEW = {
  organization: { name: 'Demo ABA Clinic' },
  period: periodOf('weekly', '2026-09-07', '2026-09-13', '2026-08-31', null),
  staff: [staff('b1', 'test1 j', 'BCBA', [5000], 360, 30000), staff('r1', 'Test2 K', 'RBT', [2500], 150, 6250)],
  summary: { staffCount: 2, paidStaffCount: 2, bcbaCount: 1, rbtCount: 1, sessionCount: 4, totalMinutes: 510, paidMinutes: 510, totalAmount: 36250, missingRateCount: 0 },
  committedStatus: null, payrollRunId: null, generatedUpToDate: null,
};
const GENERATED = {
  organization: { name: 'Demo ABA Clinic' }, period: PREVIEW.period, generated: true, status: 'DRAFT', payrollRunId: 'run-1', generatedAt: '2026-09-15T16:00:00Z',
  staff: PREVIEW.staff.map(({ missingRate, ...s }) => s),
  summary: { staffCount: 2, bcbaCount: 1, rbtCount: 1, totalMinutes: 510, totalAmount: 36250 },
};

let host; let root; let mod; let location;
beforeEach(async () => {
  mod = await import('./PeriodPayrollPanel.jsx');
  previewPeriodPayroll.mockReset(); previewPeriodPayroll.mockResolvedValue(PREVIEW);
  getGeneratedPeriodPayroll.mockReset(); getGeneratedPeriodPayroll.mockResolvedValue(null);
  generatePeriodPayroll.mockReset(); generatePeriodPayroll.mockResolvedValue({ period: PREVIEW.period, summary: PREVIEW.summary, generated: GENERATED, alreadyGenerated: false, updated: false });
  downloadPeriodPayrollXlsx.mockClear(); downloadPeriodPayrollPdf.mockClear();
  toasts.length = 0;
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

function LocationProbe() { location = useLocation(); return null; }
const mount = (url = '/payroll') => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[url]}><mod.PeriodPayrollPanel /><LocationProbe /></MemoryRouter></QueryClientProvider>));
};
const settle = async () => { for (let i = 0; i < 30; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()) || re.test(b.getAttribute('aria-label') ?? ''));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle(); };
const type = async (label, text) => {
  const input = host.querySelector(`input[aria-label="${label}"]`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle();
};
const stat = (label) => {
  const card = [...host.querySelectorAll('.rx-cl__stat')].find((s) => s.querySelector('.rx-cl__stat-label').textContent === label);
  return [card.querySelector('.rx-cl__stat-value').textContent, card.querySelector('.rx-cl__stat-hint')?.textContent ?? ''];
};
const tableRows = () => [...host.querySelectorAll('table[aria-label="Staff payroll"] tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
const totalRow = () => [...host.querySelector('table[aria-label="Staff payroll"] tfoot tr').children].map((c) => c.textContent);

describe('Payroll page', () => {
  it('opens on Weekly: the server’s latest completed Monday–Sunday week, with no browser-computed dates', async () => {
    mount(); await settle();
    expect(host.querySelector('.rx-st__title').textContent).toBe('Payroll');
    expect([...host.querySelectorAll('.rx-segmented__item')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Weekly', 'true'], ['Bi-weekly', 'false'], ['Custom', 'false']]);
    expect(previewPeriodPayroll).toHaveBeenCalledWith({ mode: 'weekly' });
    expect(getGeneratedPeriodPayroll).toHaveBeenCalledWith({ mode: 'weekly' });
    expect(host.querySelector('.rx-pr__range-text').textContent).toBe('Weekly period09/07/2026 – 09/13/2026');
    expect(host.querySelector('.rx-pr__hint').textContent).toBe('Weekly payroll covers a completed Monday to Sunday week.');
    expect(button(/Next payroll period/).disabled).toBe(true);
    expect(button(/Previous payroll period/).disabled).toBe(false);
  });

  it('payroll summary: cards, and one row per staff member with role, hourly rate, hours worked "Xh Ym" and payout, then the total', async () => {
    mount(); await settle();
    expect(stat('Payroll Period')).toEqual(['09/07/2026 – 09/13/2026', 'Weekly']);
    expect(stat('Staff Paid')).toEqual(['2', '1 BCBA · 1 RBT']);
    expect(stat('Total Worked Hours')).toEqual(['8h 30m', '']);
    expect(stat('Total Company Payroll')).toEqual(['$362.50', '']);
    expect([...host.querySelectorAll('table[aria-label="Staff payroll"] thead th')].map((t) => t.textContent)).toEqual(['Staff Name', 'Role', 'Hourly Rate', 'Hours Worked', 'Payout']);
    expect(tableRows()).toEqual([['Test1 J', 'BCBA', '$50.00/hr', '6h 00m', '$300.00'], ['Test2 K', 'RBT', '$25.00/hr', '2h 30m', '$62.50']]);
    expect(totalRow()).toEqual(['Total company payroll', '8h 30m', '$362.50']);
    expect(host.querySelector('.rx-pr__table-head').textContent).toBe('Payroll SummaryNot generated yet');
    expect(button(/^Generate Payroll$/).disabled).toBe(false);
    expect(host.textContent).not.toMatch(/\b\d+ minutes\b|session start|appointment|authorization|payload|aggregat|persist|schema|query|uuid|America\/New_York/i);
  });

  it('Bi-weekly and previous-period navigation ask the server for the completed period; the choice is kept in the URL', async () => {
    mount(); await settle();
    await click(button(/Previous payroll period/));
    expect(previewPeriodPayroll).toHaveBeenLastCalledWith({ mode: 'weekly', anchor: '2026-08-31' });
    expect(location.search).toBe('?mode=weekly&anchor=2026-08-31');
    previewPeriodPayroll.mockResolvedValue({ ...PREVIEW, period: periodOf('biweekly', '2026-08-24', '2026-09-06', '2026-08-10', null) });
    await click(button(/^Bi-weekly$/));
    expect(previewPeriodPayroll).toHaveBeenLastCalledWith({ mode: 'biweekly' });
    expect(host.querySelector('.rx-pr__range-text').textContent).toBe('Bi-weekly period08/24/2026 – 09/06/2026');
    expect(host.querySelector('.rx-pr__hint').textContent).toBe('Bi-weekly payroll covers two completed Monday to Sunday weeks.');
  });

  it('Custom: From Date and To Date are required, From after To is refused, and a valid range loads that period', async () => {
    mount(); await settle();
    const calls = previewPeriodPayroll.mock.calls.length;
    await click(button(/^Custom$/));
    expect(host.querySelector('.rx-pr__hint').textContent).toBe('Select a From Date and a To Date.');
    expect(button(/^Generate Payroll$/).disabled).toBe(true);
    await type('From Date', '09/12/2026');
    await type('To Date', '09/09/2026');
    expect(host.querySelector('.rx-pr__period').textContent).toContain('From Date must be on or before To Date.');
    expect(previewPeriodPayroll.mock.calls.length).toBe(calls);
    previewPeriodPayroll.mockResolvedValue({ ...PREVIEW, period: periodOf('custom', '2026-09-09', '2026-09-11') });
    await type('From Date', '09/09/2026');
    await type('To Date', '09/11/2026');
    expect(previewPeriodPayroll).toHaveBeenLastCalledWith({ mode: 'custom', from: '2026-09-09', to: '2026-09-11' });
    expect(location.search).toBe('?mode=custom&from=2026-09-09&to=2026-09-11');
    expect(mod.validateCustomRange({ from: '2026-09-02', to: '2026-09-01' })).toEqual({ valid: false, message: 'From Date must be on or before To Date.' });
  });

  it('Generate Payroll: confirm → ONE request → Generated Payroll with Download Excel and Download PDF; the figures stay the same', async () => {
    mount(); await settle();
    await click(button(/^Generate Payroll$/));
    expect(document.body.textContent).toContain('This saves the payroll for 09/07/2026 – 09/13/2026: 2 staff members, 8h 30m worked, total $362.50.');
    await click([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Generate Payroll').pop());
    expect(generatePeriodPayroll).toHaveBeenCalledTimes(1);
    expect(generatePeriodPayroll).toHaveBeenCalledWith({ mode: 'weekly' });
    expect(toasts.at(-1)).toBe('Payroll generated for 09/07/2026 – 09/13/2026.');
    const g = host.querySelector('.rx-pr__generated');
    expect(g.querySelector('#pr-generated').textContent).toBe('Generated Payroll');
    expect(g.querySelector('.rx-pr__sub').textContent).toBe('Payroll Period 09/07/2026 – 09/13/2026 · 2 staff members · 8h 30m worked · Generated on 09/15/2026');
    expect(host.querySelector('.rx-pr__run').textContent).toBe('Payroll generated2 staff members · $362.50');
    expect(tableRows()).toEqual([['Test1 J', 'BCBA', '$50.00/hr', '6h 00m', '$300.00'], ['Test2 K', 'RBT', '$25.00/hr', '2h 30m', '$62.50']]);
    expect(totalRow()).toEqual(['Total company payroll', '8h 30m', '$362.50']);
    await click(button(/^Download Excel$/));
    await click(button(/^Download PDF$/));
    expect(downloadPeriodPayrollXlsx).toHaveBeenCalledWith({ mode: 'weekly' });
    expect(downloadPeriodPayrollPdf).toHaveBeenCalledWith({ mode: 'weekly' });
    expect(toasts.slice(-2)).toEqual(['Excel file downloaded.', 'PDF downloaded.']);
  });

  it('an already generated period opens as Generated Payroll and cannot be generated twice', async () => {
    previewPeriodPayroll.mockResolvedValue({ ...PREVIEW, committedStatus: 'DRAFT', payrollRunId: 'run-1', generatedUpToDate: true });
    getGeneratedPeriodPayroll.mockResolvedValue(GENERATED);
    mount('/payroll?mode=weekly&anchor=2026-09-07'); await settle();
    expect(previewPeriodPayroll).toHaveBeenCalledWith({ mode: 'weekly', anchor: '2026-09-07' });
    expect(host.querySelector('#pr-generated').textContent).toBe('Generated Payroll');
    expect(button(/^Generate Payroll$/).disabled).toBe(true);
    expect(host.querySelector('.rx-pr__hint').textContent).toBe('Payroll has already been generated for this period.');
    expect(host.querySelector('.rx-pr__table-head').textContent).toBe('Payroll Summary');
  });

  it('a payroll that changed since it was generated offers Update Payroll', async () => {
    previewPeriodPayroll.mockResolvedValue({ ...PREVIEW, summary: { ...PREVIEW.summary, totalAmount: 38250 }, committedStatus: 'DRAFT', generatedUpToDate: false });
    getGeneratedPeriodPayroll.mockResolvedValue(GENERATED);
    generatePeriodPayroll.mockResolvedValue({ period: PREVIEW.period, generated: { ...GENERATED, summary: { ...GENERATED.summary, totalAmount: 38250 } }, alreadyGenerated: false, updated: true });
    mount(); await settle();
    const notice = host.querySelector('[aria-label="Payroll has changed"]');
    expect(notice.textContent).toContain('This payroll has changed since it was generated.');
    expect(notice.textContent).toContain('The payroll for this period now totals $382.50.');
    await click(notice.querySelector('button'));
    await click([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Update Payroll').pop());
    expect(toasts.at(-1)).toBe('Payroll updated for 09/07/2026 – 09/13/2026.');
  });

  it('staff without an hourly rate are listed as incomplete information — never paid $0.00', async () => {
    previewPeriodPayroll.mockResolvedValue({
      ...PREVIEW,
      staff: [...PREVIEW.staff, staff('r2', 'Mia Stone', 'RBT', [], 30, 0, { missingRate: true })],
      summary: { ...PREVIEW.summary, staffCount: 3, rbtCount: 2, missingRateCount: 1, totalMinutes: 540 },
    });
    mount(); await settle();
    const notice = host.querySelector('[aria-label="Incomplete payroll information"]');
    expect(notice.textContent).toContain('Some payroll information is incomplete.');
    expect(notice.textContent).toContain('Mia Stone (RBT) — 0h 30m worked');
    expect(notice.querySelector('a').getAttribute('href')).toBe('/staff');
    expect(tableRows()[2]).toEqual(['Mia Stone', 'RBT', 'Hourly rate not available', '0h 30m', '—']);
    expect(stat('Total Company Payroll')[0]).toBe('$362.50');
  });

  it('empty period, loading, load error with Retry, and a failed generation use plain messages', async () => {
    previewPeriodPayroll.mockResolvedValue({ ...PREVIEW, staff: [], summary: { ...PREVIEW.summary, staffCount: 0, paidStaffCount: 0, totalAmount: 0 } });
    mount(); await settle();
    expect(host.textContent).toContain('No staff worked during this payroll period');
    expect(host.textContent).toContain('No completed sessions were recorded between 09/07/2026 and 09/13/2026.');
    expect(button(/^Generate Payroll$/).disabled).toBe(true);
    act(() => root.unmount()); host.remove(); root = undefined;

    previewPeriodPayroll.mockReturnValueOnce(new Promise(() => {}));
    mount(); await settle();
    expect(host.querySelector('[aria-label="Loading payroll"]')).not.toBeNull();
    act(() => root.unmount()); host.remove(); root = undefined;

    previewPeriodPayroll.mockReset();
    previewPeriodPayroll.mockRejectedValueOnce({ response: { status: 500, data: { error: { message: 'MongoServerError: boom' } } } }).mockResolvedValue(PREVIEW);
    mount(); await settle();
    expect(host.textContent).toContain('Unable to load payroll');
    expect(host.textContent).toContain('Please try again.');
    expect(host.textContent).not.toContain('MongoServerError');
    await click(button(/^Retry$/));
    expect(tableRows()).toHaveLength(2);

    generatePeriodPayroll.mockRejectedValueOnce({ response: { status: 500 } });
    await click(button(/^Generate Payroll$/));
    await click([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Generate Payroll').pop());
    expect(toasts.at(-1)).toBe('Unable to generate payroll. Please try again.');
    downloadPeriodPayrollXlsx.mockRejectedValueOnce(new Error('Network Error'));
  });
});
