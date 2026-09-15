import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * Company Admin · Insurance Billing page. From Date + To Date → the billing
 * preview (completed sessions billed automatically at each clinician's hourly
 * rate × actual worked time, BCBA and RBT separately) → Generate Bill → the
 * GENERATED BILL read back from the persisted claims → Download Excel / PDF.
 */
const previewCompanyBilling = vi.fn();
const generateCompanyBilling = vi.fn();
const getGeneratedBill = vi.fn();
const listGeneratedBills = vi.fn();
const downloadCompanyBillingXlsx = vi.fn(() => Promise.resolve('insurance-bill.xlsx'));
const downloadCompanyBillingPdf = vi.fn(() => Promise.resolve('insurance-bill.pdf'));
vi.mock('@/api/client', () => ({
  previewCompanyBilling: (...a) => previewCompanyBilling(...a),
  generateCompanyBilling: (...a) => generateCompanyBilling(...a),
  getGeneratedBill: (...a) => getGeneratedBill(...a),
  listGeneratedBills: (...a) => listGeneratedBills(...a),
  downloadCompanyBillingXlsx: (...a) => downloadCompanyBillingXlsx(...a),
  downloadCompanyBillingPdf: (...a) => downloadCompanyBillingPdf(...a),
}));
const toasts = [];
vi.mock('@/components', () => ({ useToast: () => ({ push: (m) => toasts.push(m) }) }));
vi.mock('@/auth/store', () => ({ useOrgTimezone: () => 'America/New_York' }));
// The organization's business date is Wednesday 09/16/2026.
vi.mock('@/lib/useBusinessDate', () => ({ useBusinessDate: () => '2026-09-16' }));

const ISSUE = { code: 'MISSING_HOURLY_RATE', label: 'Hourly rate is not available for this staff member' };
const row = (id, role, name, patch = {}) => ({
  sessionId: id, role, staffProfileId: `${role}-${name}`, staffName: name, clientName: 'Raymond K', serviceDate: '2026-09-12', workDate: '2026-09-12T13:00:00Z',
  clockInAt: '2026-09-12T13:00:00Z', clockOutAt: '2026-09-12T19:00:00Z', workedMinutes: 360, intervals: [],
  authorizationId: 'svc:internal-id-1', authorizationNumber: 'AUTH-123', billingCode: '97153', payerName: 'Acme Health',
  hourlyRate: 5000, amount: 30000, billingStatus: 'READY', issues: [], claimNumber: null, ...patch,
});

/** Raymond K: BCBA Test1 J $50/hr 6h 00m → $300.00; RBT Test2 K $25/hr 0h 07m → $2.92; client $302.92. */
const client = (patch = {}) => ({
  clientId: 'c-ray', clientName: 'Raymond K', payerName: 'Acme Health',
  bcbaStaff: [{ staffProfileId: 'b1', staffName: 'Test1 J', role: 'BCBA', sessions: 1, workedMinutes: 360, hourlyRate: 5000, hourlyRates: [5000], charge: 30000, readyCount: 1, billedCount: 0 }],
  rbtStaff: [{ staffProfileId: 'r1', staffName: 'Test2 K', role: 'RBT', sessions: 1, workedMinutes: 7, hourlyRate: 2500, hourlyRates: [2500], charge: 292, readyCount: 1, billedCount: 0 }],
  unassignedStaff: [], authorizations: [],
  sessions: [row('s-b', 'BCBA', 'Test1 J'), row('s-r', 'RBT', 'Test2 K', { workedMinutes: 7, clockInAt: '2026-09-12T18:00:00Z', clockOutAt: '2026-09-12T18:07:00Z', hourlyRate: 2500, amount: 292 })],
  totalSessions: 2, totalWorkedMinutes: 367, bcbaSessions: 1, rbtSessions: 1, bcbaWorkedMinutes: 360, rbtWorkedMinutes: 7,
  bcbaCharge: 30000, rbtCharge: 292, clientTotal: 30292, readyAmount: 30292, billedAmount: 0, readyCount: 2, billedCount: 0, incompleteCount: 0, issues: [],
  ...patch,
});
const SUMMARY = {
  totalClients: 1, totalSessions: 2, bcbaSessions: 1, rbtSessions: 1, bcbaWorkedMinutes: 360, rbtWorkedMinutes: 7, totalWorkedMinutes: 367,
  bcbaCharge: 30000, rbtCharge: 292, readyToBill: 2, alreadyBilled: 0, incomplete: 0, readyAmount: 30292, billedAmount: 0, totalBillableAmount: 30292, issues: [],
};
const periodOf = (from, to) => ({ label: `${from.slice(5, 7)}/${from.slice(8)}/${from.slice(0, 4)} – ${to.slice(5, 7)}/${to.slice(8)}/${to.slice(0, 4)}`, from, to, timeZone: 'America/New_York' });
const READY = { organization: { name: 'Demo ABA Clinic' }, period: periodOf('2026-09-07', '2026-09-13'), clients: [client()], summary: SUMMARY };
/** The same sessions before the clinicians' hourly rates exist on their staff profiles. */
const INCOMPLETE = {
  ...READY,
  clients: [client({
    bcbaStaff: [{ ...client().bcbaStaff[0], hourlyRate: null, hourlyRates: [], charge: 0, readyCount: 0 }],
    rbtStaff: [{ ...client().rbtStaff[0], hourlyRate: null, hourlyRates: [], charge: 0, readyCount: 0 }],
    sessions: client().sessions.map((r) => ({ ...r, hourlyRate: null, amount: null, billingStatus: 'INCOMPLETE', issues: [ISSUE] })),
    bcbaCharge: 0, rbtCharge: 0, clientTotal: 0, readyAmount: 0, readyCount: 0, incompleteCount: 2,
  })],
  summary: { ...SUMMARY, bcbaCharge: 0, rbtCharge: 0, readyToBill: 0, incomplete: 2, readyAmount: 0, totalBillableAmount: 0,
    issues: [{ ...ISSUE, count: 2, staff: ['Test1 J', 'Test2 K'], clients: ['Raymond K'] }, { code: 'MISSING_PAYER', label: 'Insurance is not available for this client', count: 2, staff: ['Test1 J', 'Test2 K'], clients: ['Raymond K'] }] },
};
const billedClient = () => client({
  bcbaStaff: [{ ...client().bcbaStaff[0], readyCount: 0, billedCount: 1 }],
  rbtStaff: [{ ...client().rbtStaff[0], readyCount: 0, billedCount: 1 }],
  sessions: client().sessions.map((s) => ({ ...s, billingStatus: 'BILLED', claimNumber: 'CLM-202609-00001' })),
  readyCount: 0, billedCount: 2, readyAmount: 0, billedAmount: 30292,
});
const billFor = (from, to) => ({
  organization: { name: 'Demo ABA Clinic' }, period: periodOf(from, to), generated: true, persisted: true, generatedAt: '2026-09-16T15:00:00Z',
  claims: [{ id: 'clm-1', claimNumber: 'CLM-202609-00001', clientId: 'c-ray', clientName: 'Raymond K', sessionCount: 2, totalCharge: 30292 }],
  clients: [billedClient()],
  summary: { ...SUMMARY, readyToBill: 0, alreadyBilled: 2, readyAmount: 0, billedAmount: 30292 },
});
const BILLED_PREVIEW = { ...READY, clients: [billedClient()], summary: { ...SUMMARY, readyToBill: 0, alreadyBilled: 2, readyAmount: 0, billedAmount: 30292 } };
const GENERATED = { ...BILLED_PREVIEW, bill: billFor('2026-09-07', '2026-09-13'), generatedAt: '2026-09-16T15:00:00Z', alreadyGenerated: false, clientCount: 1, claimCount: 1, generatedAmount: 30292,
  claims: [{ id: 'clm-1', claimNumber: 'CLM-202609-00001', clientName: 'Raymond K', totalCharge: 30292 }] };

let host; let root; let mod; let location;
beforeEach(async () => {
  mod = await import('./ClaimsRedesign.jsx');
  previewCompanyBilling.mockReset(); previewCompanyBilling.mockResolvedValue(READY);
  generateCompanyBilling.mockReset(); generateCompanyBilling.mockResolvedValue(GENERATED);
  getGeneratedBill.mockReset(); getGeneratedBill.mockResolvedValue(null);
  listGeneratedBills.mockReset(); listGeneratedBills.mockResolvedValue([]);
  downloadCompanyBillingXlsx.mockClear(); downloadCompanyBillingPdf.mockClear();
  toasts.length = 0;
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

function LocationProbe() { location = useLocation(); return null; }
const mount = (url = '/billing') => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[url]}><mod.ClaimsRedesign /><LocationProbe /></MemoryRouter></QueryClientProvider>));
};
const settle = async () => { for (let i = 0; i < 30; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle(); };
const type = async (label, text) => {
  const input = host.querySelector(`input[aria-label="${label}"]`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle();
};
const stat = (scope, label) => {
  const card = [...host.querySelectorAll(`${scope} .rx-cl__stat`)].find((s) => s.querySelector('.rx-cl__stat-label').textContent === label);
  return [card.querySelector('.rx-cl__stat-value').textContent, card.querySelector('.rx-cl__stat-hint')?.textContent ?? ''];
};
const cellsOf = (scope, label) => [...host.querySelector(`${scope} table[aria-label="${label}"] tbody tr`).querySelectorAll('td')].map((td) => td.textContent);

describe('Insurance Billing page', () => {
  it('From Date and To Date default to the last completed week on the ORGANIZATION calendar and load it once — no child selector', async () => {
    mount(); await settle();
    expect(host.querySelector('.rx-st__head h1').textContent).toBe('Insurance Billing');
    expect(host.querySelector('.rx-st__subtitle').textContent).toBe('Generate and review insurance billing for client services within a selected date range.');
    expect([...host.querySelectorAll('.rx-ib__period label')].map((l) => l.textContent)).toEqual(['From Date*', 'To Date*']);
    expect([host.querySelector('input[aria-label="From Date"]').value, host.querySelector('input[aria-label="To Date"]').value]).toEqual(['09/07/2026', '09/13/2026']);
    expect(previewCompanyBilling).toHaveBeenCalledTimes(1);
    expect(previewCompanyBilling).toHaveBeenCalledWith({ from: '2026-09-07', to: '2026-09-13' });
    expect(getGeneratedBill).toHaveBeenCalledWith({ from: '2026-09-07', to: '2026-09-13' });
    expect(host.querySelectorAll('.rx-select__trigger')).toHaveLength(0);
    expect(mod.lastCompletedWeek('2026-09-14')).toEqual({ from: '2026-09-07', to: '2026-09-13' });
    expect(mod.lastCompletedWeek('2027-01-03')).toEqual({ from: '2026-12-21', to: '2026-12-27' });
    expect(mod.validatePeriod({ from: '2026-09-02', to: '2026-09-01' })).toEqual({ valid: false, message: 'From Date must be on or before To Date.' });
    expect(mod.validatePeriod({ from: '2026-09-01', to: '2026-09-01' }).valid).toBe(true);
  });

  it('before generation the figures are a "Billing preview" — never labelled a generated bill — with no downloads', async () => {
    mount(); await settle();
    expect(host.querySelector('#ib-preview').textContent).toBe('Billing preview');
    expect(host.querySelector('.rx-ib__preview').textContent).toContain('Not generated yet. These figures become the bill when you select Generate Bill.');
    expect(host.textContent).not.toContain('Generated Bill');
    expect(button(/Download Excel/)).toBeUndefined();
    expect(button(/Download PDF/)).toBeUndefined();
    expect(document.body.textContent).not.toMatch(/require review|requires review|needs review|approve|unit price|insurance rate/i);
    expect(document.body.textContent).not.toMatch(/payload|serializer|aggregat|resolver|persist|schema|query|uuid|object id|SessionTimeRecord|timezone|America\/New_York/i);
    expect(stat('.rx-ib__preview', 'Completed sessions')).toEqual(['2', '1 BCBA · 1 RBT']);
    expect(stat('.rx-ib__preview', 'Total worked time')).toEqual(['6h 07m', 'BCBA 6h 00m · RBT 0h 07m']);
    expect(stat('.rx-ib__preview', 'Ready to bill')).toEqual(['2', '$302.92']);
    expect(stat('.rx-ib__preview', 'Preview total')).toEqual(['$302.92', 'BCBA $300.00 · RBT $2.92']);
    expect(button(/^Generate Bill$/).disabled).toBe(false);
  });

  it('client bill: BCBA and RBT separately with hourly rate, worked time and charge, then the client total; session activity has no internal ids', async () => {
    mount(); await settle();
    const bill = host.querySelector('.rx-ib__preview .rx-ib__bill');
    expect(bill.querySelector('.rx-ib__client-name').textContent).toBe('Raymond K');
    expect(bill.querySelector('.rx-ib__role--bcba .rx-ib__clinician').textContent).toBe('Test1 J$50.00/hr6h 00m worked$300.00');
    expect(bill.querySelector('.rx-ib__role--rbt .rx-ib__clinician').textContent).toBe('Test2 K$25.00/hr0h 07m worked$2.92');
    expect(bill.querySelector('.rx-ib__client-total').textContent).toBe('Client total$302.92');
    await click(button(/View session activity/));
    expect([...host.querySelectorAll('table[aria-label="BCBA Session Activity"] thead th')].map((t) => t.textContent))
      .toEqual(['Service date', 'Clinician', 'Role', 'Session start', 'Session end', 'Worked time', 'Authorization', 'Billing code', 'Hourly rate', 'Billable amount', 'Status']);
    expect(cellsOf('.rx-ib__preview', 'BCBA Session Activity')).toEqual(['09/12/2026', 'Test1 J', 'BCBA', '9:00 AM', '3:00 PM', '6h 00m', 'AUTH-123', '97153', '$50.00/hr', '$300.00', 'Ready to bill']);
    expect(cellsOf('.rx-ib__preview', 'RBT Session Activity')).toEqual(['09/12/2026', 'Test2 K', 'RBT', '2:00 PM', '2:07 PM', '0h 07m', 'AUTH-123', '97153', '$25.00/hr', '$2.92', 'Ready to bill']);
    expect(host.textContent).not.toContain('svc:internal-id-1');
  });

  it('missing hourly rates are incomplete billing data with where to fix them; Generate Bill stays disabled', async () => {
    previewCompanyBilling.mockResolvedValue(INCOMPLETE);
    mount(); await settle();
    const notice = host.querySelector('.rx-ib__notice');
    expect(notice.textContent).toContain('Some billing information is incomplete for 2 sessions.');
    expect(notice.textContent).toContain('These sessions are included automatically once the missing information is added.');
    expect(notice.textContent).toContain('Hourly rate is not available for this staff member — Test1 J, Test2 K');
    expect(notice.textContent).toContain('Insurance is not available for this client — Raymond K');
    expect(host.querySelector('.rx-ib__role--bcba .rx-ib__clinician').textContent).toBe('Test1 JHourly rate not available6h 00m worked—');
    expect(notice.querySelector('a').getAttribute('href')).toBe('/staff');
    expect(host.querySelector('.rx-ib__role--bcba .rx-ib__role-charge').textContent).toBe('—', 'no fake $0.00 charge');
    expect(host.querySelector('.rx-ib__client-total').textContent).toBe('Client total—');
    expect(button(/^Generate Bill$/).disabled).toBe(true);
  });

  it('Generate Bill: confirm → ONE request for the period → the Generated Bill (period, clients, sessions, worked time, total) with BCBA and RBT, no reload', async () => {
    mount(); await settle();
    await click(button(/^Generate Bill$/));
    expect(document.body.textContent).toContain('2 completed sessions across 1 client, $302.92');
    await click([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Generate Bill').pop());
    expect(generateCompanyBilling).toHaveBeenCalledTimes(1);
    expect(generateCompanyBilling).toHaveBeenCalledWith({ from: '2026-09-07', to: '2026-09-13' });

    const g = host.querySelector('.rx-ib__generated');
    expect(g.querySelector('#ib-generated').textContent).toBe('Generated Bill');
    expect(g.querySelector('.rx-ib__generated-head .rx-ib__sub').textContent).toBe('Billing Period 09/07/2026 – 09/13/2026 · Generated on 09/16/2026');
    // A bill summary: no claim numbers, session tables, status badges or timezone.
    expect(g.textContent).not.toMatch(/CLM-|View session activity|billed|America\/New_York|Session start|Authorization|Billing code/);
    expect(g.querySelector('.rx-ib__total--bill .rx-ib__total-label').textContent).toBe('Total company insurance billing');
    expect([...g.querySelectorAll('.rx-ib__total--bill .rx-ib__downloads button')].map((b) => b.textContent)).toEqual(['Download Excel', 'Download PDF']);
    expect(stat('.rx-ib__generated', 'Clients')).toEqual(['1', '']);
    expect(stat('.rx-ib__generated', 'Sessions')).toEqual(['2', '1 BCBA · 1 RBT']);
    expect(stat('.rx-ib__generated', 'Total worked time')).toEqual(['6h 07m', 'BCBA 6h 00m · RBT 0h 07m']);
    expect(stat('.rx-ib__generated', 'Total bill')).toEqual(['$302.92', 'BCBA $300.00 · RBT $2.92']);
    expect(g.querySelector('.rx-ib__role--bcba .rx-ib__clinician').textContent).toBe('Test1 J$50.00/hr6h 00m worked$300.00');
    expect(g.querySelector('.rx-ib__role--rbt .rx-ib__clinician').textContent).toBe('Test2 K$25.00/hr0h 07m worked$2.92');
    expect(g.querySelector('.rx-ib__total-value').textContent).toBe('$302.92');
    expect(host.querySelector('.rx-ib__run').textContent).toBe('Bill generated1 client · $302.92');
    expect(host.querySelector('.rx-ib__preview')).toBeNull();
    expect(button(/^Generate Bill$/).disabled).toBe(true);
    expect(host.querySelector('.rx-ib__hint').textContent).toBe('A bill has already been generated for this period.');
    expect(previewCompanyBilling).toHaveBeenCalledTimes(1);
    expect(toasts.at(-1)).toBe('Bill generated for 1 client.');

    await click(button(/Download Excel/));
    await click(button(/Download PDF/));
    expect(downloadCompanyBillingXlsx).toHaveBeenCalledWith({ from: '2026-09-07', to: '2026-09-13' });
    expect(downloadCompanyBillingPdf).toHaveBeenCalledWith({ from: '2026-09-07', to: '2026-09-13' });
    expect(toasts.at(-2)).toBe('Excel file downloaded.');
  });

  it('refresh / return visit: the period in the URL reopens the persisted bill with its downloads, and it cannot be generated twice', async () => {
    previewCompanyBilling.mockResolvedValue({ ...BILLED_PREVIEW, period: periodOf('2026-09-01', '2026-09-14') });
    getGeneratedBill.mockResolvedValue(billFor('2026-09-01', '2026-09-14'));
    mount('/billing?from=2026-09-01&to=2026-09-14'); await settle();
    expect(previewCompanyBilling).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-14' });
    expect(getGeneratedBill).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-14' });
    expect([host.querySelector('input[aria-label="From Date"]').value, host.querySelector('input[aria-label="To Date"]').value]).toEqual(['09/01/2026', '09/14/2026']);
    expect(host.querySelector('#ib-generated').textContent).toBe('Generated Bill');
    expect(stat('.rx-ib__generated', 'Total bill')[0]).toBe('$302.92');
    expect(button(/^Generate Bill$/).disabled).toBe(true);
    await click(button(/Download Excel/));
    expect(downloadCompanyBillingXlsx).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-14' });
    expect(generateCompanyBilling).not.toHaveBeenCalled();
  });

  it('dates: a valid change loads that period and is kept in the URL; From after To is refused with a message; empty dates never load', async () => {
    mount(); await settle();
    await type('From Date', '09/01/2026');
    expect(previewCompanyBilling).toHaveBeenLastCalledWith({ from: '2026-09-01', to: '2026-09-13' });
    expect(getGeneratedBill).toHaveBeenLastCalledWith({ from: '2026-09-01', to: '2026-09-13' });
    expect(location.search).toBe('?from=2026-09-01&to=2026-09-13');
    const calls = previewCompanyBilling.mock.calls.length;

    await type('From Date', '09/20/2026');
    expect(host.querySelector('.rx-ib__period').textContent).toContain('From Date must be on or before To Date.');
    expect(button(/^Generate Bill$/).disabled).toBe(true);
    expect(previewCompanyBilling.mock.calls.length).toBe(calls);

    await type('From Date', '');
    expect(host.querySelector('.rx-ib__hint').textContent).toBe('Select a From Date and a To Date.');
    expect(button(/^Generate Bill$/).disabled).toBe(true);
    expect(previewCompanyBilling.mock.calls.length).toBe(calls);

    await type('From Date', '09/13/2026');
    expect(previewCompanyBilling).toHaveBeenLastCalledWith({ from: '2026-09-13', to: '2026-09-13' });
  });

  it('generated bills can be reopened from the list', async () => {
    listGeneratedBills.mockResolvedValue([
      { from: '2026-08-24', to: '2026-08-30', label: '08/24/2026 – 08/30/2026', claimCount: 2, clientCount: 2, generatedAt: '2026-09-01T15:00:00Z' },
    ]);
    mount(); await settle();
    const item = host.querySelector('.rx-ib__history-item');
    expect(item.textContent).toContain('08/24/2026 – 08/30/2026');
    expect(item.textContent).toContain('2 clients · Generated on 09/01/2026');
    expect(item.textContent).not.toContain('claim');
    await click(button(/Open bill/));
    expect(getGeneratedBill).toHaveBeenLastCalledWith({ from: '2026-08-24', to: '2026-08-30' });
    expect([host.querySelector('input[aria-label="From Date"]').value, host.querySelector('input[aria-label="To Date"]').value]).toEqual(['08/24/2026', '08/30/2026']);
  });

  it('an already generated period returns the existing bill — no duplicate', async () => {
    generateCompanyBilling.mockResolvedValue({ ...GENERATED, alreadyGenerated: true, clientCount: 0, claimCount: 0, claims: [], generatedAmount: 0 });
    mount(); await settle();
    await click(button(/^Generate Bill$/));
    await click([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Generate Bill').pop());
    expect(toasts.at(-1)).toBe('A bill for this period already exists.');
    expect(host.querySelector('.rx-ib__run').textContent).toContain('A bill for this period already exists');
    expect(host.querySelector('#ib-generated').textContent).toBe('Generated Bill');
  });

  it('a bill generated before the RBT was billable is flagged, and Update Bill brings the RBT onto the bill the Excel is built from', async () => {
    // Raymond K: Test1 J $10/hr 404 min = $67.33 is on the bill; Test2 K $20/hr 7 min = $2.33 became ready afterwards.
    const bcba = { staffProfileId: 'b1', staffName: 'Test1 J', role: 'BCBA', sessions: 9, workedMinutes: 404, hourlyRate: 1000, hourlyRates: [1000], charge: 6733 };
    const rbt = { staffProfileId: 'r1', staffName: 'Test2 K', role: 'RBT', sessions: 5, workedMinutes: 7, hourlyRate: 2000, hourlyRates: [2000], charge: 233 };
    const bcbaRows = [row('s-b', 'BCBA', 'Test1 J', { staffProfileId: 'b1', workedMinutes: 404, hourlyRate: 1000, amount: 6733, billingStatus: 'BILLED', claimNumber: 'CLM-202609-00001' })];
    const rbtRows = [row('s-r', 'RBT', 'Test2 K', { staffProfileId: 'r1', workedMinutes: 7, hourlyRate: 2000, amount: 233 })];
    const base = { totalSessions: 14, bcbaSessions: 9, rbtSessions: 5, bcbaWorkedMinutes: 404, rbtWorkedMinutes: 7, totalWorkedMinutes: 411, issues: [] };
    const panel = {
      ...READY,
      clients: [client({ bcbaStaff: [{ ...bcba, readyCount: 0, billedCount: 9 }], rbtStaff: [{ ...rbt, readyCount: 5, billedCount: 0 }], sessions: [...bcbaRows, ...rbtRows], ...base,
        bcbaCharge: 6733, rbtCharge: 233, clientTotal: 6966, readyAmount: 233, billedAmount: 6733, readyCount: 5, billedCount: 9 })],
      summary: { ...SUMMARY, ...base, bcbaCharge: 6733, rbtCharge: 233, readyToBill: 5, alreadyBilled: 9, readyAmount: 233, billedAmount: 6733, totalBillableAmount: 6966 },
    };
    const staleBill = {
      ...billFor('2026-09-07', '2026-09-13'),
      claims: [{ id: 'clm-1', claimNumber: 'CLM-202609-00001', clientId: 'c-ray', clientName: 'Raymond K', sessionCount: 9, totalCharge: 6733 }],
      clients: [client({ bcbaStaff: [{ ...bcba, readyCount: 0, billedCount: 9 }], rbtStaff: [], sessions: bcbaRows, totalSessions: 9, totalWorkedMinutes: 404, bcbaSessions: 9, rbtSessions: 0, rbtWorkedMinutes: 0,
        bcbaCharge: 6733, rbtCharge: 0, clientTotal: 6733, readyAmount: 0, billedAmount: 6733, readyCount: 0, billedCount: 9 })],
      summary: { ...SUMMARY, totalSessions: 9, bcbaSessions: 9, rbtSessions: 0, bcbaWorkedMinutes: 404, rbtWorkedMinutes: 0, totalWorkedMinutes: 404, bcbaCharge: 6733, rbtCharge: 0, readyToBill: 0, alreadyBilled: 9, readyAmount: 0, billedAmount: 6733, totalBillableAmount: 6733 },
    };
    const fullBill = {
      ...staleBill,
      claims: [{ ...staleBill.claims[0], sessionCount: 14, totalCharge: 6966 }],
      clients: [client({ bcbaStaff: [{ ...bcba, readyCount: 0, billedCount: 9 }], rbtStaff: [{ ...rbt, readyCount: 0, billedCount: 5 }], sessions: [...bcbaRows, ...rbtRows.map((r) => ({ ...r, billingStatus: 'BILLED', claimNumber: 'CLM-202609-00001' }))], ...base,
        bcbaCharge: 6733, rbtCharge: 233, clientTotal: 6966, readyAmount: 0, billedAmount: 6966, readyCount: 0, billedCount: 14 })],
      summary: { ...panel.summary, readyToBill: 0, alreadyBilled: 14, readyAmount: 0, billedAmount: 6966 },
    };
    previewCompanyBilling.mockResolvedValue(panel);
    getGeneratedBill.mockResolvedValue(staleBill);
    generateCompanyBilling.mockResolvedValue({ ...panel, summary: fullBill.summary, bill: fullBill, alreadyGenerated: false, clientCount: 1, claimCount: 0, updatedClaimCount: 1, addedSessionCount: 5, generatedAmount: 233,
      claims: [{ id: 'clm-1', claimNumber: 'CLM-202609-00001', clientName: 'Raymond K', updated: true, sessionCount: 5, totalCharge: 233 }] });
    mount(); await settle();

    const g = () => host.querySelector('.rx-ib__generated');
    expect(g().querySelector('.rx-ib__total-value').textContent).toBe('$67.33', 'the bill shows exactly what the Excel holds');
    const notice = g().querySelector('[aria-label="Sessions not on this bill"]');
    expect(notice.textContent).toContain('Not on this bill yet: 5 completed sessions ($2.33).');
    expect(notice.textContent).toContain('The Excel and PDF contain only what is on the bill.');
    expect(notice.textContent).toContain('Raymond K — RBT Test2 K · 5 sessions');
    expect(host.querySelector('.rx-ib__period .rx-btn').textContent).toBe('Update Bill');
    expect(host.querySelector('.rx-ib__hint').textContent).toBe('5 completed sessions are ready but not on the generated bill yet. Select Update Bill to add them.');
    // The live panel keeps BCBA + RBT = $69.66.
    expect(host.querySelector('.rx-ib__preview .rx-ib__role--rbt .rx-ib__clinician').textContent).toBe('Test2 K$20.00/hr0h 07m worked$2.33');
    expect(host.querySelector('.rx-ib__preview .rx-ib__client-total').textContent).toBe('Client total$69.66');

    await click(notice.querySelector('button'));
    expect(document.body.textContent).toContain('This adds 5 completed sessions ($2.33) to the bill for 09/07/2026 – 09/13/2026: Raymond K — RBT Test2 K (5 sessions).');
    await click([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Update Bill').pop());
    expect(generateCompanyBilling).toHaveBeenCalledWith({ from: '2026-09-07', to: '2026-09-13' });
    expect(toasts.at(-1)).toBe('Bill updated — 5 sessions added.');
    expect(host.querySelector('.rx-ib__run').textContent).toBe('Bill updated5 sessions added · $2.33');

    expect(g().querySelector('[aria-label="Sessions not on this bill"]')).toBeNull();
    expect(g().querySelector('.rx-ib__role--bcba .rx-ib__clinician').textContent).toBe('Test1 J$10.00/hr6h 44m worked$67.33');
    expect(g().querySelector('.rx-ib__role--rbt .rx-ib__clinician').textContent).toBe('Test2 K$20.00/hr0h 07m worked$2.33');
    expect(g().querySelector('.rx-ib__client-total').textContent).toBe('Client total$69.66');
    expect(g().querySelector('.rx-ib__total-value').textContent).toBe('$69.66');
    expect(host.querySelector('.rx-ib__preview')).toBeNull();
    await click(button(/Download Excel/));
    expect(downloadCompanyBillingXlsx).toHaveBeenCalledWith({ from: '2026-09-07', to: '2026-09-13' });
  });

  it('download and generation failures use plain messages', async () => {
    getGeneratedBill.mockResolvedValue(billFor('2026-09-07', '2026-09-13'));
    previewCompanyBilling.mockResolvedValue(BILLED_PREVIEW);
    downloadCompanyBillingXlsx.mockRejectedValueOnce(new Error('Request failed with status code 500'));
    downloadCompanyBillingPdf.mockRejectedValueOnce(new Error('Network Error'));
    mount(); await settle();
    await click(button(/Download Excel/));
    expect(toasts.at(-1)).toBe('Unable to download the bill. Please try again.');
    await click(button(/Download PDF/));
    expect(toasts.at(-1)).toBe('Unable to download the bill. Please try again.');

    act(() => root.unmount()); host.remove(); root = undefined;
    getGeneratedBill.mockResolvedValue(null);
    previewCompanyBilling.mockResolvedValue(READY);
    generateCompanyBilling.mockRejectedValueOnce(new Error('Network Error'));
    mount(); await settle();
    await click(button(/^Generate Bill$/));
    await click([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Generate Bill').pop());
    expect(toasts.at(-1)).toBe('Unable to generate the bill. Please try again.');
  });

  it('an empty period says there are no completed sessions', async () => {
    previewCompanyBilling.mockResolvedValue({ ...READY, clients: [], summary: { ...SUMMARY, totalClients: 0, totalSessions: 0, readyToBill: 0, totalBillableAmount: 0 } });
    mount(); await settle();
    expect(host.textContent).toContain('No completed sessions were recorded for any client between 09/07/2026 and 09/13/2026.');
    expect(button(/^Generate Bill$/).disabled).toBe(true);
  });

  it('loading shows a skeleton; an API error shows the message and a working Retry', async () => {
    previewCompanyBilling.mockReturnValueOnce(new Promise(() => {}));
    mount(); await settle();
    expect(host.querySelector('[aria-label="Loading billing"]')).not.toBeNull();
    act(() => root.unmount()); host.remove(); root = undefined;

    previewCompanyBilling.mockReset();
    previewCompanyBilling.mockRejectedValueOnce({ response: { data: { error: { message: 'From Date must be on or before To Date.' } } } }).mockResolvedValue(READY);
    mount(); await settle();
    expect(host.textContent).toContain('Unable to load billing for this period');
    expect(host.textContent).toContain('From Date must be on or before To Date.');
    await click(button(/^Retry$/));
    expect(host.querySelector('.rx-ib__bill')).not.toBeNull();
  });
});
