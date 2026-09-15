import { describe, it, expect } from 'vitest';
import { companyStatus, matchesCompanyFilter, COMPANY_FILTERS } from './company-status';

/**
 * Super Admin console must speak plain language — no PROVISIONING/SUSPENDED
 * codes reach the screen. These pin the mapping and the filter groups.
 */
describe('companyStatus — plain language', () => {
  it('maps lifecycle codes to friendly labels', () => {
    expect(companyStatus('ACTIVE').label).toBe('Active');
    expect(companyStatus('SUSPENDED').label).toBe('Deactivated');
    expect(companyStatus('PROVISIONING').label).toBe('Pending invitation');
    expect(companyStatus('PENDING_AGREEMENT').label).toBe('Pending invitation');
  });

  it('never leaks a raw ALL_CAPS underscore code', () => {
    for (const s of ['ACTIVE', 'SUSPENDED', 'PROVISIONING', 'PENDING_AGREEMENT', 'OFFBOARDING', 'DESTROYED', 'WEIRD_NEW_STATE']) {
      expect(companyStatus(s).label).not.toMatch(/[A-Z]{2,}|_/);
    }
  });

  it('gives a safe label for null/unknown', () => {
    expect(companyStatus(null).label).toBe('Unknown');
    expect(companyStatus(undefined).label).toBe('Unknown');
  });

  it('assigns soft badge tones', () => {
    expect(companyStatus('ACTIVE').tone).toBe('ok');
    expect(companyStatus('SUSPENDED').tone).toBe('off');
  });
});

describe('matchesCompanyFilter', () => {
  it('All matches everything', () => {
    expect(matchesCompanyFilter('ACTIVE', 'all')).toBe(true);
    expect(matchesCompanyFilter('SUSPENDED', 'all')).toBe(true);
  });
  it('groups pending states together', () => {
    expect(matchesCompanyFilter('PROVISIONING', 'pending')).toBe(true);
    expect(matchesCompanyFilter('PENDING_AGREEMENT', 'pending')).toBe(true);
    expect(matchesCompanyFilter('ACTIVE', 'pending')).toBe(false);
  });
  it('maps Deactivated to SUSPENDED only', () => {
    expect(matchesCompanyFilter('SUSPENDED', 'deactivated')).toBe(true);
    expect(matchesCompanyFilter('ACTIVE', 'deactivated')).toBe(false);
  });
  it('exposes exactly the four plain filters', () => {
    expect(COMPANY_FILTERS.map((f) => f.label)).toEqual(['All', 'Active', 'Deactivated', 'Pending invitation']);
  });
});
