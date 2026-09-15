import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Behavior tests for the last-mile forms. They render through a real router +
 * query client and assert client-side validation gates submission (no network
 * needed to prove the guard). Every state update is wrapped in act(), so these
 * add zero act() warnings.
 *
 * The API client is mocked so the mount-time `useQuery(listClients)` resolves
 * locally instead of firing a real axios→XHR to the dev server — an unmocked
 * call was leaking ECONNREFUSED across the parallel run and intermittently
 * failing sibling tests. Mocking removes the race at its source.
 */
vi.mock('@/api/client', () => ({
  createPlan: vi.fn(() => Promise.resolve({ id: 'p-new' })),
  updatePlan: vi.fn(() => Promise.resolve({ id: 'p-1' })),
  getPlan: vi.fn(() => Promise.resolve({ plan: {}, goals: [] })),
  listClients: vi.fn(() => Promise.resolve({ items: [] })),
}));
import { PlanEditorRedesign } from './PlanEditorRedesign.jsx';
import { createPlan } from '@/api/client';

let container; let root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

function renderApp(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/plans/new']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  ));
}

describe('PlanEditorRedesign (create)', () => {
  it('renders the create form WITHOUT a Responsible BCBA field (derived from the creator)', () => {
    renderApp(<PlanEditorRedesign />);
    expect(container.textContent).toContain('New treatment plan');
    expect(container.textContent).toContain('Plan title');
    // spec Module 7.1: creation no longer asks who the responsible BCBA is —
    // the authenticated BCBA is the creator.
    expect(container.textContent).not.toContain('Responsible BCBA');
  });

  it('blocks submit and shows validation messages when required fields are empty', () => {
    renderApp(<PlanEditorRedesign />);
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /Create plan/.test(b.textContent));
    expect(saveBtn).toBeTruthy();
    act(() => saveBtn.click());
    // Validation errors appear (child/title); the mutation never fired.
    expect(container.textContent).toMatch(/required|Choose the child/);
    // and there is no Responsible-BCBA validation message any more
    expect(container.textContent).not.toMatch(/Assign the responsible BCBA/);
  });
});

describe('PlanEditorRedesign — surfaces the real server reason on 422', () => {
  const CLIENT = '22222222-2222-4222-8222-222222222222';

  function renderPreset(ui) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/plans/new?clientId=${CLIENT}`]}>{ui}</MemoryRouter>
      </QueryClientProvider>,
    ));
  }
  function typeInto(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  async function flush() {
    for (let i = 0; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
  }

  it('shows the API plain-language reason (client not active), not a generic "check the required fields"', async () => {
    createPlan.mockRejectedValueOnce({
      response: { status: 422, data: { error: { code: 'CLIENT_NOT_ACTIVE', message: 'Only active clients may have a treatment plan.' } } },
    });
    renderPreset(<PlanEditorRedesign />);
    typeInto(container.querySelector('input[placeholder="e.g. Q3 Behavior Support Plan"]'), 'Language plan');
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /Create plan/.test(b.textContent));
    act(() => saveBtn.click());
    await flush();
    expect(createPlan).toHaveBeenCalled();
    expect(container.textContent).toContain('Only active clients may have a treatment plan.');
    expect(container.textContent).not.toContain('Check the required fields');
  });

  it('surfaces the BCBA-not-active reason verbatim', async () => {
    createPlan.mockRejectedValueOnce({
      response: { status: 422, data: { error: { code: 'BCBA_INVALID', message: 'The responsible BCBA must be an active staff member.' } } },
    });
    renderPreset(<PlanEditorRedesign />);
    typeInto(container.querySelector('input[placeholder="e.g. Q3 Behavior Support Plan"]'), 'Plan');
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /Create plan/.test(b.textContent));
    act(() => saveBtn.click());
    await flush();
    expect(container.textContent).toContain('The responsible BCBA must be an active staff member.');
  });

  it('BCBA: treatment-plan dates picked on the shared calendar reach createPlan as YYYY-MM-DD', async () => {
    createPlan.mockResolvedValueOnce({ id: 'p-new' });
    renderPreset(<PlanEditorRedesign />);
    typeInto(container.querySelector('input[placeholder="e.g. Q3 Behavior Support Plan"]'), 'Plan');
    const effective = container.querySelector('input[aria-label="Effective date"]');
    typeInto(effective, '09012026');
    expect(effective.value).toBe('09/01/2026');
    const openBtn = effective.parentElement.querySelector('button[aria-label="Open calendar"]');
    act(() => openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.querySelector('.dp-pop [role="grid"]').getAttribute('aria-label')).toBe('September 2026');
    act(() => document.querySelector('.dp-pop [data-iso="2026-09-14"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(effective.value).toBe('09/14/2026');
    typeInto(container.querySelector('input[aria-label="Review date"]'), '12152026');
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /Create plan/.test(b.textContent));
    act(() => saveBtn.click());
    await flush();
    expect(createPlan).toHaveBeenCalledWith(expect.objectContaining({ effectiveDate: '2026-09-14', reviewDate: '2026-12-15' }));
  });

  it('falls back to the generic message when the server sends no readable reason', async () => {
    createPlan.mockRejectedValueOnce({ response: { status: 500, data: {} } });
    renderPreset(<PlanEditorRedesign />);
    typeInto(container.querySelector('input[placeholder="e.g. Q3 Behavior Support Plan"]'), 'Plan');
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /Create plan/.test(b.textContent));
    act(() => saveBtn.click());
    await flush();
    expect(container.textContent).toContain('Could not save the plan');
  });
});
