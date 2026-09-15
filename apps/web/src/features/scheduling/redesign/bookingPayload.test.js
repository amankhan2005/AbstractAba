import { describe, it, expect } from 'vitest';
import { buildBookingPayload, missingBookingFields } from './bookingPayload.js';

/**
 * The rebuilt booking contract: separate BCBA + RBT, a list of authorizations,
 * calendar dates + clock times, and positive units. These pin the corrected
 * payload the strict createAppointmentSchema now accepts.
 */
describe('buildBookingPayload', () => {
  const base = {
    clientId: '11111111-1111-1111-1111-111111111111',
    bcbaId: '22222222-2222-2222-2222-222222222222',
    rbtId: '44444444-4444-4444-4444-444444444444',
    authorizationIds: ['33333333-3333-3333-3333-333333333333'],
    startDate: '2026-08-27',
    startTime: '09:00',
    units: '4',
  };

  it('includes every field the backend requires', () => {
    const p = buildBookingPayload(base);
    expect(Object.keys(p).sort()).toEqual(
      ['authorizationIds', 'bcbaId', 'clientId', 'endDate', 'rbtId', 'startDate', 'startTime', 'units'],
    );
    expect(p.authorizationIds).toEqual(base.authorizationIds);
    expect(p.bcbaId).toBe(base.bcbaId);
    expect(p.rbtId).toBe(base.rbtId);
  });

  it('carries multiple authorizations and defaults endDate to startDate', () => {
    const p = buildBookingPayload({ ...base, authorizationIds: ['a-1', 'svc:a-2'] });
    expect(p.authorizationIds).toEqual(['a-1', 'svc:a-2']);
    expect(p.endDate).toBe(base.startDate); // no endDate supplied → mirrors startDate
    expect(p.startTime).toBe('09:00');
  });

  it('includes endTime only when supplied, and clamps units to a positive integer', () => {
    const withEnd = buildBookingPayload({ ...base, endTime: '10:00' });
    expect(withEnd.endTime).toBe('10:00');
    const clamped = buildBookingPayload({ ...base, units: '0' });
    expect(clamped.units).toBe(1);
    expect('endTime' in clamped).toBe(false);
  });

  it('omits startTime/endTime entirely for a date-only (timeless) booking — the creation UI sends no time (spec §2)', () => {
    const { startTime, ...noTime } = base;
    const p = buildBookingPayload(noTime);
    expect(p).not.toHaveProperty('startTime');
    expect(p).not.toHaveProperty('endTime');
    // The scheduling DATE is still present.
    expect(p.startDate).toBe(base.startDate);
    expect(Object.keys(p).sort()).toEqual(['authorizationIds', 'bcbaId', 'clientId', 'endDate', 'rbtId', 'startDate', 'units']);
  });
});

describe('missingBookingFields', () => {
  it('flags a missing authorization and requires at least one clinician', () => {
    const missing = missingBookingFields({
      clientId: 'c', bcbaId: '', rbtId: '', authorizationIds: [], startDate: '2026-08-27', startTime: '09:00',
    });
    expect(missing).toContain('authorization');
    expect(missing).toContain('clinician');
  });

  it('accepts a BCBA-only booking (RBT optional)', () => {
    expect(missingBookingFields({
      clientId: 'c', bcbaId: 'b', rbtId: '', authorizationIds: ['a'], startDate: 'd',
    })).toEqual([]);
  });

  it('accepts an RBT-only booking (BCBA optional)', () => {
    expect(missingBookingFields({
      clientId: 'c', bcbaId: '', rbtId: 'r', authorizationIds: ['a'], startDate: 'd',
    })).toEqual([]);
  });

  it('does not require a start time (worked time comes from the session, not the appointment)', () => {
    expect(missingBookingFields({
      clientId: 'c', bcbaId: 'b', rbtId: '', authorizationIds: ['a'], startDate: 'd', startTime: '',
    })).toEqual([]);
  });

  it('returns nothing when the booking is complete', () => {
    expect(missingBookingFields({
      clientId: 'c', bcbaId: 'b', rbtId: 'r', authorizationIds: ['a'], startDate: 'd', startTime: 't',
    })).toEqual([]);
  });
});

import { authorizationLabel, authorizationDetails } from './bookingPayload.js';

describe('authorizationLabel', () => {
  const auth = {
    id: 'auth-1', authorizationNumber: 'AUTH-2001', serviceCode: '97153',
    startDate: '2026-08-01', endDate: '2026-12-31', status: 'ACTIVE',
    authorizedUnits: 100, remainingUnits: 76,
  };
  it('is rich and human-readable with MM/DD/YYYY dates', () => {
    const label = authorizationLabel(auth);
    expect(label).toContain('AUTH-2001');
    expect(label).toContain('97153');
    expect(label).toContain('08/01/2026');
    expect(label).toContain('12/31/2026');
    expect(label).toContain('76/100u left');
    expect(label).toContain('ACTIVE');
  });
  it('never emits undefined/null/NaN for sparse authorizations', () => {
    const label = authorizationLabel({ id: 'x' });
    expect(label).not.toMatch(/undefined|null|NaN/);
  });
});

describe('authorizationDetails', () => {
  it('derives hours from units and formats dates, no raw nullish', () => {
    const rows = authorizationDetails({
      authorizationNumber: 'AUTH-9', serviceCode: '97153',
      startDate: '2026-08-01', endDate: '2026-12-31', status: 'ACTIVE',
      authorizedUnits: 100, remainingUnits: 40,
    });
    const map = Object.fromEntries(rows);
    expect(map['Start date']).toBe('08/01/2026');
    expect(map['Total hours']).toBe('25 hrs');       // 100 × 0.25
    expect(map['Remaining hours']).toBe('10 hrs');   // 40 × 0.25
    expect(map['Remaining units']).toBe('40');
  });
  it('uses "Not available" for missing fields, never undefined/null/NaN', () => {
    const rows = authorizationDetails({});
    for (const [, v] of rows) expect(String(v)).not.toMatch(/undefined|null|NaN|\[object Object\]/);
    expect(Object.fromEntries(rows)['Authorization #']).toBe('Not available');
  });
});
