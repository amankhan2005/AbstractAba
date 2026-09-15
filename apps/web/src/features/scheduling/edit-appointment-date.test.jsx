import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Edit / Reschedule appointment (Parts 26-27). The stored UTC datetime is edited
 * as a masked MM/DD/YYYY date + a time field; an existing 2026-09-03 renders as
 * 09/03/2026 in the visible editable control (never a locale native date input).
 */

const getAppointment = vi.fn();
const listClients = vi.fn(() => Promise.resolve({ items: [] }));
const listStaff = vi.fn(() => Promise.resolve({ items: [] }));
const listAuthorizations = vi.fn(() => Promise.resolve({ items: [] }));
const listCareTeam = vi.fn(() => Promise.resolve({ items: [] }));
vi.mock('@/api/client', () => ({
  getAppointment: (...a) => getAppointment(...a),
  listClients: (...a) => listClients(...a),
  listStaff: (...a) => listStaff(...a),
  listAuthorizations: (...a) => listAuthorizations(...a),
  listCareTeam: (...a) => listCareTeam(...a),
  bookAppointment: vi.fn(), updateAppointment: vi.fn(),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let AppointmentFormPage;

beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ AppointmentFormPage } = await import('./AppointmentFormPage.jsx'));
  getAppointment.mockReset();
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/scheduling/appointments/appt-1/edit']}>
        <Routes><Route path="/scheduling/appointments/:appointmentId/edit" element={<AppointmentFormPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
};
const startDate = () => document.querySelector('input[aria-label="Start date"]');
const settle = async () => { for (let i = 0; i < 40; i += 1) { if (startDate()?.value) return; await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); } };

describe('Edit Appointment date input', () => {
  it('renders the stored 2026-09-03 date as 09/03/2026 in a masked text field', async () => {
    getAppointment.mockResolvedValue({
      id: 'appt-1', clientId: '11111111-1111-1111-1111-111111111111',
      staffProfileId: '22222222-2222-2222-2222-222222222222',
      authorizationId: '33333333-3333-3333-3333-333333333333',
      startAt: '2026-09-03T14:00:00.000Z', endAt: '2026-09-03T15:00:00.000Z',
      units: 4, notes: '', version: 3,
    });
    mount();
    await settle();
    expect(startDate()).toBeTruthy();
    expect(startDate().getAttribute('type')).toBe('text');
    expect(startDate().value).toBe('09/03/2026');
    expect(document.body.textContent).not.toMatch(/Invalid Date|NaN/);
  });
});
