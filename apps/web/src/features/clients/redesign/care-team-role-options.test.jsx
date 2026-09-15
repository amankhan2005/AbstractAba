import { describe, it, expect } from 'vitest';
import { ROLE_OPTS } from './AssignmentPanel.jsx';

/**
 * Spec Modules 1.5 / 1.6 / 4.2 / 4.3 — the care-team role selector must offer
 * EXACTLY BCBA, RBT and Manager. "Therapist" is retired from the selector and
 * "Clinical manager" is relabelled to "Manager" (the internal MANAGER key is
 * unchanged). This pins the user-facing options so a regression can't quietly
 * reintroduce Therapist or the old label.
 */
describe('care-team role selector options', () => {
  it('offers exactly BCBA, RBT and Manager', () => {
    expect(ROLE_OPTS.map((o) => o.value)).toEqual(['BCBA', 'RBT', 'MANAGER']);
  });

  it('never offers Therapist as a value or a label', () => {
    const blob = JSON.stringify(ROLE_OPTS).toLowerCase();
    expect(blob).not.toContain('therapist');
  });

  it('labels the MANAGER key as "Manager", not "Clinical manager"', () => {
    const manager = ROLE_OPTS.find((o) => o.value === 'MANAGER');
    expect(manager?.label).toBe('Manager');
  });

  it('keeps BCBA and RBT labels clean (no parenthetical role descriptions)', () => {
    expect(ROLE_OPTS.find((o) => o.value === 'BCBA')?.label).toBe('BCBA');
    expect(ROLE_OPTS.find((o) => o.value === 'RBT')?.label).toBe('RBT');
  });
});
