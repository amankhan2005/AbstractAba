import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Active-session documentation (spec §1–§8). The RBT sees What / How / Child
 * response WHILE the session runs, pre-filled from the persisted values (reload/
 * navigation survival), and an explicit Save issues ONE bounded request with the
 * three fields. Save state is honest ("Saved" only after success). The panel is
 * rendered by ActiveSessionHero from bcbaSessionUi.jsx.
 */

const APPT = '01a051e4-c8fd-71a1-b09e-3e86422eb6c2';
const CHILD = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const getRbtChildDetail = vi.fn();
const saveRbtSessionDocumentation = vi.fn(() => Promise.resolve({}));

vi.mock('@/api/client', () => ({
  getBcbaChildDetail: (...a) => getRbtChildDetail(...a),
  saveBcbaSessionDocumentation: vi.fn(() => Promise.resolve({})),
  saveRbtSessionDocumentation: (...a) => saveRbtSessionDocumentation(...a),
  startBcbaSession: vi.fn(), stopBcbaSession: vi.fn(), completeBcbaSession: vi.fn(),
}));

let host; let root; let ActiveSessionHero;

beforeEach(async () => {
  ({ ActiveSessionHero } = await import('./bcbaSessionUi.jsx'));
  getRbtChildDetail.mockReset(); saveRbtSessionDocumentation.mockClear();
  saveRbtSessionDocumentation.mockResolvedValue({});
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
});

const card = { appointmentId: APPT, clientId: CHILD, startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3.6e6).toISOString(), startedAt: new Date(Date.now() - 6e5).toISOString(), timeSet: true };

const mount = (variant = 'bcba') => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><MemoryRouter>
      <ActiveSessionHero card={card} childName="John Smith" onStop={() => {}} stopping={false}
        fetchChildDetail={getRbtChildDetail} detailKey="rbt" saveDocumentation={saveRbtSessionDocumentation}
        variant={variant} />
    </MemoryRouter></QueryClientProvider>,
  ));
};
const settle = async () => { for (let i = 0; i < 40; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const qa = (sel) => [...host.querySelectorAll(sel)];
const areaByLabel = (re) => qa('.rx-formfield').find((f) => re.test(f.textContent))?.querySelector('textarea');
const type = async (el, v) => { await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve();
}); };
const clickButton = async (re) => { const b = qa('button').find((x) => re.test(x.textContent)); await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };

describe('ActiveSessionHero — in-session documentation', () => {
  it('shows the three fields, pre-filled from persisted documentation', async () => {
    getRbtChildDetail.mockResolvedValue({
      child: { firstName: 'John' }, appointment: { authorizations: [] }, activePlan: null,
      session: { status: 'IN_PROGRESS', documentation: { what: 'Requesting practice', how: 'Prompting', childResponse: 'Great' } },
    });
    mount(); await settle();
    expect(host.textContent).toContain('Session Documentation');
    expect(host.textContent).toMatch(/What did you work on today\?/);
    expect(host.textContent).toMatch(/How was the intervention implemented\?/);
    expect(host.textContent).toMatch(/How did the client respond\?/);
    expect(areaByLabel(/What did you work on today\?/).value).toBe('Requesting practice');
    expect(areaByLabel(/How was the intervention implemented\?/).value).toBe('Prompting');
    expect(areaByLabel(/How did the client respond\?/).value).toBe('Great');
  });

  it('shows the no-plan fallback yet still offers documentation', async () => {
    getRbtChildDetail.mockResolvedValue({ child: { firstName: 'John' }, appointment: { authorizations: [] }, activePlan: null, session: { status: 'IN_PROGRESS', documentation: null } });
    mount(); await settle();
    expect(host.textContent).toMatch(/No active Treatment Plan is available/i);
    expect(host.textContent).toMatch(/What did you work on today\?/);
  });

  it('saves the three fields in ONE request and shows "Saved" only after success', async () => {
    getRbtChildDetail.mockResolvedValue({ child: { firstName: 'John' }, appointment: { authorizations: [] }, activePlan: { title: 'Functional Communication', goalCount: 2, programCount: 1 }, session: { status: 'IN_PROGRESS', documentation: null } });
    mount(); await settle();
    await type(areaByLabel(/What did you work on today\?/), 'Practiced requesting preferred items');
    await type(areaByLabel(/How was the intervention implemented\?/), 'Used prompting and reinforcement');
    await type(areaByLabel(/How did the client respond\?/), 'Requested items independently');
    await clickButton(/Save documentation/);
    await settle();
    expect(saveRbtSessionDocumentation).toHaveBeenCalledTimes(1);
    const [appointmentId, body] = saveRbtSessionDocumentation.mock.calls[0];
    expect(appointmentId).toBe(APPT);
    // The BCBA request carries the three documentation fields AND the memo —
    // one bounded write, never one request per field.
    expect(body).toEqual({
      what: 'Practiced requesting preferred items',
      how: 'Used prompting and reinforcement',
      childResponse: 'Requested items independently',
      memo: '',
    });
    expect(host.textContent).toMatch(/Saved/);
  });
});

/**
 * Additional coverage for the RBT in-session documentation experience.
 * Everything below drives the SAME ActiveSessionHero the RBT dashboard renders —
 * there is no separate RBT documentation component, and these tests would fail
 * if one were introduced.
 */
describe('RBT in-session workflow — memo only, plan read-only', () => {
  it('shows a Session Memo and NOT the BCBA documentation fields', async () => {
    getRbtChildDetail.mockResolvedValue({ appointment: { authorizations: [] }, activePlan: null, session: { documentation: {}, memo: null } });
    mount('rbt'); await settle();

    expect(host.textContent).toContain('Session Memo');
    // The three clinical documentation prompts are the BCBA's workflow and must
    // not appear for an RBT.
    expect(host.textContent).not.toMatch(/What did you work on today\?/);
    expect(host.textContent).not.toMatch(/How was the intervention implemented\?/);
    expect(host.textContent).not.toMatch(/How did the client respond\?/);
    expect(qa('textarea').length).toBe(1);
  });

  it('sends ONLY the memo — never the BCBA documentation fields', async () => {
    getRbtChildDetail.mockResolvedValue({ appointment: { authorizations: [] }, activePlan: null, session: { documentation: {}, memo: null } });
    mount('rbt'); await settle();

    await type(areaByLabel(/Session Memo/), 'Worked on requesting during snack time.');
    await clickButton(/Save memo/i);
    await settle();

    const [, body] = saveRbtSessionDocumentation.mock.calls[0];
    expect(body).toEqual({ memo: 'Worked on requesting during snack time.' });
    expect(body.what).toBeUndefined();
    expect(body.how).toBeUndefined();
    expect(body.childResponse).toBeUndefined();
  });

  it('the memo survives a reload — it rehydrates from the persisted value', async () => {
    getRbtChildDetail.mockResolvedValue({
      appointment: { authorizations: [] }, activePlan: null,
      session: { documentation: {}, memo: 'Client engaged throughout the session.' },
    });

    mount('rbt'); await settle();
    expect(areaByLabel(/Session Memo/).value).toBe('Client engaged throughout the session.');

    // "Reload": tear the tree down entirely and mount again. Nothing survives
    // in React state, so the value can only have come from the server.
    act(() => root.unmount()); host.remove(); root = undefined; host = undefined;
    mount('rbt'); await settle();

    expect(areaByLabel(/Session Memo/).value).toBe('Client engaged throughout the session.');
  });

  it('lets the RBT write a memo with NO active treatment plan — no error, no block', async () => {
    getRbtChildDetail.mockResolvedValue({ appointment: { authorizations: [] }, activePlan: null, session: { documentation: {}, memo: null } });
    mount('rbt'); await settle();

    expect(host.textContent).toMatch(/No active Treatment Plan is available/i);
    expect(host.textContent).not.toMatch(/error|failed|undefined|null/i);
    expect(areaByLabel(/Session Memo/).disabled).toBe(false);

    await type(areaByLabel(/Session Memo/), 'Worked on tolerating transitions');
    await clickButton(/Save memo/i);
    await settle();
    expect(saveRbtSessionDocumentation).toHaveBeenCalledTimes(1);
  });

  it('shows the treatment plan as READ-ONLY guidance with its goals and programs', async () => {
    getRbtChildDetail.mockResolvedValue({
      appointment: { authorizations: [] },
      activePlan: {
        id: 'p1', title: 'Spring 2026 Plan', goalCount: 2, programCount: 1,
        goals: [
          { id: 'g1', description: 'Request preferred items independently' },
          { id: 'g2', description: 'Tolerate transitions between activities' },
        ],
        programs: [{ id: 'pr1', name: 'Manding' }],
      },
      session: { documentation: {}, memo: null },
    });
    mount('rbt'); await settle();

    expect(host.textContent).toContain('Spring 2026 Plan');
    expect(host.textContent).toContain('Request preferred items independently');
    expect(host.textContent).toContain('Tolerate transitions between activities');
    expect(host.textContent).toContain('Manding');
    expect(host.textContent).toMatch(/view.only/i);

    // READ-ONLY: the plan renders as text. The memo is the ONLY editable
    // control, and there is no create/edit/delete/activate/archive affordance.
    expect(qa('textarea').length).toBe(1);
    expect(qa('input').length).toBe(0);
    const planEdit = qa('button').find((b) => /edit|add|delete|archive|activate/i.test(b.textContent));
    expect(planEdit).toBeUndefined();
  });

  it('never shows engineering terminology to the clinician', async () => {
    getRbtChildDetail.mockResolvedValue({ appointment: { authorizations: [] }, activePlan: null, session: { documentation: {}, memo: null } });
    mount('rbt'); await settle();
    const text = host.textContent;
    for (const banned of ['UUID', 'payload', 'schema', 'repository', 'UTC', 'timestamp', 'backend', 'API', '422']) {
      expect(text, `leaked "${banned}" into the UI`).not.toContain(banned);
    }
  });
});
