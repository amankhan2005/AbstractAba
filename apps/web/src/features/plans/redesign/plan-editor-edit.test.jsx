import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Edit mode reads the persisted plan from getPlan's { plan, goals } envelope:
 * the form is pre-filled with the real values and the save carries the plan's
 * real version as If-Match (a missing version made every edit fail).
 */
const updatePlan = vi.fn(() => Promise.resolve({ id: 'p-1' }));
vi.mock('@/api/client', () => ({
  createPlan: vi.fn(),
  updatePlan: (...a) => updatePlan(...a),
  getPlan: vi.fn(() => Promise.resolve({
    plan: { id: 'p-1', clientId: 'c-1', title: 'Behavior Support', status: 'ACTIVE', effectiveDate: '2026-09-01T00:00:00.000Z', reviewDate: '2026-12-01T00:00:00.000Z', notes: 'Focus on transitions.', version: 4 },
    goals: [],
  })),
  listClients: vi.fn(() => Promise.resolve({ items: [] })),
}));
import { PlanEditorRedesign } from './PlanEditorRedesign.jsx';

let container; let root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); updatePlan.mockClear(); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const settle = async () => { for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe('PlanEditorRedesign (edit)', () => {
  it('pre-fills the saved plan and saves with its version', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/plans/p-1/edit']}>
          <Routes><Route path="/plans/:planId/edit" element={<PlanEditorRedesign />} /><Route path="/plans/:planId" element={<div>detail</div>} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await settle();
    const title = container.querySelector('input[placeholder="e.g. Q3 Behavior Support Plan"]');
    expect(title.value).toBe('Behavior Support');
    expect(container.querySelector('textarea').value).toBe('Focus on transitions.');

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(title, 'Behavior Support (Revised)');
    await act(async () => { title.dispatchEvent(new Event('input', { bubbles: true })); });
    const save = [...container.querySelectorAll('button')].find((b) => /Save changes/.test(b.textContent));
    await act(async () => { save.click(); });
    await settle();
    expect(updatePlan).toHaveBeenCalledTimes(1);
    const [id, body, version] = updatePlan.mock.calls[0];
    expect(id).toBe('p-1');
    expect(version).toBe(4);
    expect(body).toMatchObject({ title: 'Behavior Support (Revised)', effectiveDate: '2026-09-01', reviewDate: '2026-12-01', notes: 'Focus on transitions.', status: 'ACTIVE' });
    expect(container.textContent).toContain('detail');
  });
});
