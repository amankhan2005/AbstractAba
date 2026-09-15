// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Super Admin website inquiries page. Lists inquiries, opens the detail view,
 * and sends status and note updates. Query hooks are mocked; access control
 * and persistence are covered by the API suite. act()-clean.
 */
const updateMut = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
let inquiryData = { items: [], counts: { NEW: 0, CONTACTED: 0, CLOSED: 0 } };

vi.mock('@/api/queries', () => ({
  useInquiries: () => ({ data: inquiryData, isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateInquiry: () => updateMut,
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let InquiriesRx; let ToastProvider;

const SAMPLE = {
  id: 'inq-1', name: 'Jane Doe', organization: 'Bright Steps ABA', email: 'jane@brightsteps.example', phone: null,
  subject: 'Product walkthrough', message: 'Line one.\n<script>alert(1)</script>', status: 'NEW',
  internalNote: null, contactedAt: null, closedAt: null, createdAt: '2026-09-15T14:30:00.000Z',
};

beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ InquiriesRx } = await import('./InquiriesRx.jsx'));
  ({ ToastProvider } = await import('@/components'));
  updateMut.mutateAsync.mockClear();
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<ToastProvider><InquiriesRx /></ToastProvider>));
};
const btn = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };

describe('InquiriesRx — Super Admin website inquiries', () => {
  it('shows an empty state when there are no inquiries', () => {
    inquiryData = { items: [], counts: { NEW: 0, CONTACTED: 0, CLOSED: 0 } };
    mount();
    expect(host.textContent).toMatch(/No inquiries yet/);
  });

  it('lists inquiries with status and opens the detail view with the message as text', async () => {
    inquiryData = { items: [SAMPLE], counts: { NEW: 1, CONTACTED: 0, CLOSED: 0 } };
    mount();
    expect(host.textContent).toContain('Jane Doe');
    expect(host.textContent).toContain('Product walkthrough');
    expect(host.querySelector('.rxc-badge').textContent).toBe('New');

    await click(btn(/^View$/));
    const message = document.querySelector('.rxc-inquiry-message');
    expect(message.textContent).toContain('<script>alert(1)</script>');
    expect(message.querySelector('script')).toBeNull();
    expect(document.body.textContent).toContain('jane@brightsteps.example');
  });

  it('marks an inquiry contacted and closed through the update mutation', async () => {
    inquiryData = { items: [SAMPLE], counts: { NEW: 1, CONTACTED: 0, CLOSED: 0 } };
    mount();
    await click(btn(/^View$/));
    await click(btn(/Mark contacted/));
    expect(updateMut.mutateAsync).toHaveBeenCalledWith({ id: 'inq-1', body: { status: 'CONTACTED' } });
    await click(btn(/Mark closed/));
    expect(updateMut.mutateAsync).toHaveBeenCalledWith({ id: 'inq-1', body: { status: 'CLOSED' } });
  });

  it('saves a trimmed internal note', async () => {
    inquiryData = { items: [SAMPLE], counts: { NEW: 1, CONTACTED: 0, CLOSED: 0 } };
    mount();
    await click(btn(/^View$/));
    const textarea = document.querySelector('textarea');
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, '  Called back.  ');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(btn(/Save note/));
    expect(updateMut.mutateAsync).toHaveBeenCalledWith({ id: 'inq-1', body: { internalNote: 'Called back.' } });
  });

  it('filters by status', async () => {
    inquiryData = { items: [SAMPLE, { ...SAMPLE, id: 'inq-2', name: 'Sam Lee', status: 'CLOSED' }], counts: { NEW: 1, CONTACTED: 0, CLOSED: 1 } };
    mount();
    await click([...document.querySelectorAll('.rxc-filter')].find((b) => /Closed/.test(b.textContent)));
    expect(host.querySelector('tbody').textContent).toContain('Sam Lee');
    expect(host.querySelector('tbody').textContent).not.toContain('Jane Doe');
  });
});
