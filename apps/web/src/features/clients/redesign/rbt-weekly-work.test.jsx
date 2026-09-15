import { describe, it, expect } from 'vitest';
import { weeklyItemsFrom } from './RbtChildView.jsx';

/**
 * Spec Module 8.1/8.4 — the RBT "this week" list is derived from the REAL plan
 * model: goals carry `description`, programs `name`, targets `label`. weeklyFocus
 * targets take priority; otherwise the goals' descriptions are shown. Never
 * renders undefined and never invents a task system.
 */
describe('weeklyItemsFrom', () => {
  it('returns [] for no plan', () => {
    expect(weeklyItemsFrom(null)).toEqual([]);
    expect(weeklyItemsFrom({})).toEqual([]);
  });

  it('shows weeklyFocus targets by their real label, with instructions', () => {
    const plan = {
      goals: [{
        id: 'g1', description: 'Increase manding',
        programs: [{ id: 'p1', name: 'Mand training', targets: [
          { id: 't1', label: 'Request "more"', weeklyFocus: true, weeklyInstructions: 'Prompt every 5 min' },
          { id: 't2', label: 'Not this week', weeklyFocus: false },
        ] }],
      }],
    };
    const out = weeklyItemsFrom(plan);
    expect(out).toEqual([{ id: 't1', label: 'Request "more"', note: 'Prompt every 5 min' }]);
  });

  it('falls back to goal DESCRIPTIONS (not a missing name field) when nothing is flagged', () => {
    const plan = { goals: [
      { id: 'g1', description: 'Increase manding', programs: [] },
      { id: 'g2', description: 'Reduce elopement', programs: [{ id: 'p2', name: 'Safety', targets: [{ id: 't3', label: 'x', weeklyFocus: false }] }] },
    ] };
    expect(weeklyItemsFrom(plan)).toEqual([
      { id: 'g1', label: 'Increase manding', note: '' },
      { id: 'g2', label: 'Reduce elopement', note: '' },
    ]);
  });

  it('never yields undefined labels even with sparse data', () => {
    const plan = { goals: [{ id: 'g1', programs: [{ id: 'p1', targets: [{ id: 't1', weeklyFocus: true }] }] }] };
    const out = weeklyItemsFrom(plan);
    expect(out[0].label).toBe('Target'); // final defensive fallback, never undefined
  });
});
