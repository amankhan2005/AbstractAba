import { describe, it, expect } from 'vitest';
import { isStaffEligibleForRole, CARE_TEAM_ROLE_TO_ROLEKEYS } from './AssignmentPanel.jsx';

/**
 * Spec Module 4 Parts 8/12/13/17-19 — care-team role filtering must use the
 * staff member's CANONICAL roleKeys, never the legacy free-text discipline.
 * BCBA -> only bcba, RBT -> only rbt, Manager -> only managerial keys. No
 * cross-role leakage; multi-role staff appear in every seat they qualify for;
 * legacy rows without roleKeys never crash and are simply not eligible.
 */
const bcba = { id: '1', firstName: 'B', lastName: 'One', roleKeys: ['bcba'] };
const rbt = { id: '2', firstName: 'R', lastName: 'Two', roleKeys: ['rbt'] };
const manager = { id: '3', firstName: 'M', lastName: 'Three', roleKeys: ['org_admin'] };
const owner = { id: '4', firstName: 'O', lastName: 'Four', roleKeys: ['owner'] };
const multi = { id: '5', firstName: 'X', lastName: 'Five', roleKeys: ['bcba', 'org_admin'] };
const legacy = { id: '6', firstName: 'L', lastName: 'Six', discipline: 'BCBA' }; // no roleKeys
const roster = [bcba, rbt, manager, owner, multi, legacy];

describe('care-team eligibility uses canonical roleKeys', () => {
  it('BCBA seat returns only staff holding the bcba key', () => {
    const ids = roster.filter((s) => isStaffEligibleForRole(s, 'BCBA')).map((s) => s.id);
    expect(ids).toEqual(['1', '5']); // bcba + multi(bcba); NOT the legacy discipline-only row
  });

  it('RBT seat returns only staff holding the rbt key', () => {
    const ids = roster.filter((s) => isStaffEligibleForRole(s, 'RBT')).map((s) => s.id);
    expect(ids).toEqual(['2']);
  });

  it('Manager seat returns only managerial keys (owner / org_admin)', () => {
    const ids = roster.filter((s) => isStaffEligibleForRole(s, 'MANAGER')).map((s) => s.id);
    expect(ids).toEqual(['3', '4', '5']); // org_admin, owner, multi(org_admin)
  });

  it('never leaks across roles: a pure RBT is not eligible for a BCBA seat', () => {
    expect(isStaffEligibleForRole(rbt, 'BCBA')).toBe(false);
    expect(isStaffEligibleForRole(bcba, 'RBT')).toBe(false);
  });

  it('does not depend on discipline: a legacy discipline-only row is not eligible via free text', () => {
    expect(isStaffEligibleForRole(legacy, 'BCBA')).toBe(false);
  });

  it('legacy rows without roleKeys do not crash the selector', () => {
    expect(() => isStaffEligibleForRole({ id: 'z' }, 'BCBA')).not.toThrow();
    expect(isStaffEligibleForRole({ id: 'z' }, 'BCBA')).toBe(false);
  });

  it('there is no Therapist mapping', () => {
    expect(CARE_TEAM_ROLE_TO_ROLEKEYS.THERAPIST).toBeUndefined();
    expect(Object.keys(CARE_TEAM_ROLE_TO_ROLEKEYS)).toEqual(['BCBA', 'RBT', 'MANAGER']);
  });
});
