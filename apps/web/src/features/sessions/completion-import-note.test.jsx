import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Phase 4 §5/§10 — "Import from Session Note" copies the SAVED Session Note
 * into the per-authorization memo input for editing, and never silently
 * overwrites an existing memo (confirm first). A UI copy into the existing
 * field — no new model.
 *
 * IMPORTS THE SESSION MEMO, not the three documentation questions. Session
 * Documentation (what / how / client response) is a separate BCBA concept with
 * its own fields; copying it into a billing-facing authorization memo
 * duplicated the clinical record and made the box unreadable.
 */
vi.mock('@/api/client', () => ({}));

let host; let root; let SessionCompletionModal;

const PAYLOAD = {
  appointmentId: 'appt-1',
  startedAt: '2026-09-10T17:30:00Z',
  endedAt: '2026-09-10T18:45:00Z',
  durationText: '1h 15m',
  eligibleAuthorizations: [{ id: 'svc:A1', label: 'AUTH-1 · ABA' }],
  selectedAuthorizationId: 'svc:A1',
  documentation: { what: 'Requesting practice', how: 'Prompting', childResponse: 'Great' },
  memo: 'Worked on requesting during snack time. Client engaged throughout.',
};

beforeEach(async () => {
  ({ SessionCompletionModal } = await import('./bcbaSessionUi.jsx'));
  host = document.createElement('div'); document.body.appendChild(host);
});
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const mount = (complete = vi.fn(() => Promise.resolve({}))) => {
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><SessionCompletionModal payload={PAYLOAD} childName="H Y" complete={complete} onClose={() => {}} onCompleted={() => {}} /></QueryClientProvider>));
  return complete;
};
const settle = async () => { for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const bodyBtn = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent));
const click = async (re) => { const b = bodyBtn(re); await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };
const memoArea = () => [...document.querySelectorAll('textarea')][0];
const typeMemo = async (v) => { const el = memoArea(); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(el, v); await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve(); }); };

describe('SessionCompletionModal — Import from Session Note', () => {
  it('fills an empty memo with the saved Session Memo', async () => {
    mount(); await settle();
    // the single eligible auth is pre-selected → its memo field is visible
    await click(/Import from Session Note/);
    await settle();
    const v = memoArea().value;
    expect(v).toBe('Worked on requesting during snack time. Client engaged throughout.');
    // The documentation questions must NOT be duplicated into this field.
    expect(v).not.toMatch(/What did you work on/i);
    expect(v).not.toMatch(/How was the intervention implemented/i);
    expect(v).not.toMatch(/How did the client respond/i);
    expect(v).not.toContain('Requesting practice');
  });

  it('does NOT silently overwrite an existing memo — it asks to confirm', async () => {
    mount(); await settle();
    await typeMemo('my existing memo');
    await click(/Import from Session Note/);
    await settle();
    // memo unchanged until confirmed
    expect(memoArea().value).toBe('my existing memo');
    expect(document.body.textContent).toMatch(/Replace the current memo/i);
    // Cancel keeps it
    await click(/^Cancel$/);
    await settle();
    expect(memoArea().value).toBe('my existing memo');
    // Import again → Replace applies the Session Note
    await click(/Import from Session Note/);
    await settle();
    await click(/^Replace$/);
    await settle();
    expect(memoArea().value).toBe('Worked on requesting during snack time. Client engaged throughout.');
  });
});
