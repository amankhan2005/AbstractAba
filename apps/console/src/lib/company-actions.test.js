import { describe, it, expect } from 'vitest';
import {
  companyActions, resolvePlan, isVersionConflict, actionErrorMessage,
  VERSION_CONFLICT_MESSAGE, DEACTIVATE_REASON, ACTIVATE_REASON,
} from './company-actions';

describe('companyActions — plain-language Activate / Deactivate mapping', () => {
  it('an ACTIVE company offers Deactivate (danger), transitioning to SUSPENDED', () => {
    const [a, ...rest] = companyActions({ state: 'ACTIVE', tradingName: 'Sunrise ABA' });
    expect(rest).toHaveLength(0);
    expect(a.label).toBe('Deactivate Company');
    expect(a.tone).toBe('danger');
    expect(a.via).toBe('transition');
    expect(a.toState).toBe('SUSPENDED');
    expect(a.reason).toBe(DEACTIVATE_REASON);
    expect(a.confirm.title).toBe('Deactivate Sunrise ABA?');
    expect(a.confirm.confirmLabel).toBe('Deactivate Company');
    expect(a.confirm.message).toMatch(/no longer be able to access/i);
  });

  it('a SUSPENDED (deactivated) company offers Activate, transitioning to ACTIVE', () => {
    const [a] = companyActions({ state: 'SUSPENDED', tradingName: 'Sunrise ABA' });
    expect(a.label).toBe('Activate Company');
    expect(a.tone).toBe('primary');
    expect(a.via).toBe('transition');
    expect(a.toState).toBe('ACTIVE');
    expect(a.reason).toBe(ACTIVATE_REASON);
    expect(a.confirm.title).toBe('Activate Sunrise ABA?');
    expect(a.confirm.message).toMatch(/access their company panel/i);
  });

  it('a PENDING_AGREEMENT company activates via the onboarding endpoint', () => {
    const [a] = companyActions({ state: 'PENDING_AGREEMENT', tradingName: 'X' });
    expect(a.label).toBe('Activate Company');
    expect(a.via).toBe('onboarding-activate');
    expect(a.toState).toBeUndefined();
  });

  it('a PROVISIONING company offers Set up (never a raw "provision")', () => {
    const [a] = companyActions({ state: 'PROVISIONING', tradingName: 'X' });
    expect(a.label).toBe('Set up');
    expect(a.via).toBe('provision');
  });

  it('every actionable state exposes exactly one primary lifecycle action', () => {
    expect(companyActions({ state: 'ACTIVE' }).filter((a) => a.confirm)).toHaveLength(1);
    expect(companyActions({ state: 'SUSPENDED' }).filter((a) => a.confirm)).toHaveLength(1);
  });

  it('confirmation copy never exposes technical terms', () => {
    const all = ['ACTIVE', 'SUSPENDED', 'PENDING_AGREEMENT']
      .flatMap((state) => companyActions({ state, tradingName: 'Co' }))
      .map((a) => `${a.label} ${a.confirm?.title ?? ''} ${a.confirm?.message ?? ''}`)
      .join(' ')
      .toLowerCase();
    for (const term of ['tenant', 'organization', 'provision', 'transition', 'suspend', 'offboard', 'if-match', 'membership']) {
      expect(all).not.toContain(term);
    }
  });
});

describe('resolvePlan — real catalogue only, never fabricated', () => {
  const catalogue = [
    { code: 'growth', name: 'Growth', active: true },
    { code: 'legacy', name: 'Legacy', active: false },
  ];

  it('resolves an assigned plan code to its display name + status', () => {
    const p = resolvePlan({ planCode: 'growth' }, catalogue);
    expect(p).toMatchObject({ assigned: true, name: 'Growth', status: 'Active', code: 'growth' });
  });

  it('marks an archived plan as Archived', () => {
    expect(resolvePlan({ planCode: 'legacy' }, catalogue).status).toBe('Archived');
  });

  it('no plan assigned → friendly label, not a fake plan', () => {
    const p = resolvePlan({ planCode: null }, catalogue);
    expect(p).toMatchObject({ assigned: false, name: 'No plan assigned', status: null });
  });

  it('an assigned code missing from the catalogue falls back to the code, not an invented name', () => {
    const p = resolvePlan({ planCode: 'ghost' }, catalogue);
    expect(p.name).toBe('ghost');
    expect(p.status).toBeNull();
  });

  it('surfaces an allocation date only when the record actually carries one', () => {
    expect(resolvePlan({ planCode: 'growth' }, catalogue).allocatedAt).toBeNull();
    expect(resolvePlan({ planCode: 'growth', planAssignedAt: '2026-01-05' }, catalogue).allocatedAt).toBe('2026-01-05');
  });
});

describe('optimistic-concurrency conflict handling', () => {
  it('detects a 409 as a version conflict', () => {
    expect(isVersionConflict({ response: { status: 409 } })).toBe(true);
  });
  it('detects the VERSION_CONFLICT error code as a conflict', () => {
    expect(isVersionConflict({ response: { data: { error: { code: 'VERSION_CONFLICT' } } } })).toBe(true);
  });
  it('a plain failure is not a conflict', () => {
    expect(isVersionConflict({ response: { status: 500 } })).toBe(false);
  });
  it('a conflict maps to the refresh-and-retry message', () => {
    expect(actionErrorMessage({ response: { status: 409 } })).toBe(VERSION_CONFLICT_MESSAGE);
  });
  it('a non-conflict surfaces the backend message when present, else a friendly fallback', () => {
    expect(actionErrorMessage({ response: { data: { error: { message: 'Nope' } } } })).toBe('Nope');
    expect(actionErrorMessage({})).toMatch(/couldn't complete/i);
  });
});
