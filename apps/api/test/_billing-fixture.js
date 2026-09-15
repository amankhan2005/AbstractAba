import { aggregateCompanyBilling } from '../src/modules/claims/billing.aggregate.js';

/**
 * Shared, DB-free billing scenario (America/New_York organization).
 *
 * John Doe — Acme Health insurance.
 *   BCBA Ben Carter  $50/hr · 09/12 · 2h 00m · AUTH-2002 (97155)
 *   BCBA Ellen Ng    $60/hr · 09/13 · 1h 00m · AUTH-2002
 *   RBT  Ann Lee     $25/hr · 09/12 · three work periods totalling 2h 30m · AUTH-1001 (97153)
 * Amy Ray — no insurance on file.
 *   RBT  David Brown (no hourly rate) · 09/13 · 45m · AUTH-B1
 *
 * Authorizations carry no rate; the hourly rate comes from each clinician's
 * Staff Profile PayRate.
 */
export const TZ = 'America/New_York';
const at = (iso) => new Date(iso);

export function scenario(overrides = {}) {
  const sessions = [
    { _id: 's1', clientId: 'cA', staffProfileId: 'b1', appointmentId: 'ap1', status: 'FROZEN', startedAt: at('2026-09-12T13:00:00Z'), endedAt: at('2026-09-12T15:00:00Z'), selectedAuthorizationIds: ['svc:A2'], intervals: [{ startedAt: at('2026-09-12T13:00:00Z'), endedAt: at('2026-09-12T15:00:00Z') }] },
    { _id: 's2', clientId: 'cA', staffProfileId: 'b2', appointmentId: 'ap2', status: 'FROZEN', startedAt: at('2026-09-13T14:00:00Z'), endedAt: at('2026-09-13T15:00:00Z'), selectedAuthorizationIds: ['svc:A2'] },
    { _id: 's3', clientId: 'cA', staffProfileId: 'r1', appointmentId: 'ap3', status: 'FROZEN', startedAt: at('2026-09-12T13:00:00Z'), endedAt: at('2026-09-12T19:00:00Z'), selectedAuthorizationId: 'svc:A1',
      intervals: [
        { startedAt: at('2026-09-12T13:00:00Z'), endedAt: at('2026-09-12T13:30:00Z') },
        { startedAt: at('2026-09-12T15:00:00Z'), endedAt: at('2026-09-12T16:00:00Z') },
        { startedAt: at('2026-09-12T18:00:00Z'), endedAt: at('2026-09-12T19:00:00Z') },
      ] },
    { _id: 's4', clientId: 'cB', staffProfileId: 'r2', appointmentId: 'ap4', status: 'FROZEN', startedAt: at('2026-09-13T18:00:00Z'), endedAt: at('2026-09-13T18:45:00Z'), selectedAuthorizationIds: ['svc:B1'] },
  ];
  const input = {
    sessions,
    workedById: new Map([['s1', 120], ['s2', 60], ['s3', 150], ['s4', 45]]),
    apptById: new Map([
      ['ap1', { _id: 'ap1', bcbaId: 'b1', rbtId: null }], ['ap2', { _id: 'ap2', bcbaId: 'b2', rbtId: null }],
      ['ap3', { _id: 'ap3', bcbaId: null, rbtId: 'r1' }], ['ap4', { _id: 'ap4', bcbaId: null, rbtId: 'r2' }],
    ]),
    staffById: new Map([
      ['b1', { _id: 'b1', firstName: 'Ben', lastName: 'Carter' }], ['b2', { _id: 'b2', firstName: 'Ellen', lastName: 'Ng' }],
      ['r1', { _id: 'r1', firstName: 'Ann', lastName: 'Lee' }], ['r2', { _id: 'r2', firstName: 'David', lastName: 'Brown' }],
    ]),
    clientById: new Map([['cA', { _id: 'cA', firstName: 'John', lastName: 'Doe' }], ['cB', { _id: 'cB', firstName: 'Amy', lastName: 'Ray' }]]),
    authById: new Map([
      ['svc:A1', { id: 'svc:A1', clientId: 'cA', authorizationNumber: 'AUTH-1001', serviceType: 'ABA', billingCode: '97153', authorizedUnits: 100, status: 'APPROVED', startDate: at('2026-08-01T00:00:00Z'), endDate: at('2026-12-31T00:00:00Z') }],
      ['svc:A2', { id: 'svc:A2', clientId: 'cA', authorizationNumber: 'AUTH-2002', serviceType: 'ABA', billingCode: '97155', authorizedUnits: 50, status: 'NOT_SENT', startDate: at('2026-08-01T00:00:00Z'), endDate: at('2026-12-31T00:00:00Z') }],
      ['svc:B1', { id: 'svc:B1', clientId: 'cB', authorizationNumber: 'AUTH-B1', serviceType: 'ABA', billingCode: null, authorizedUnits: 20, status: 'NOT_SENT', startDate: at('2026-08-01T00:00:00Z'), endDate: at('2026-12-31T00:00:00Z') }],
    ]),
    payRatesByStaffId: new Map([
      ['b1', [{ staffProfileId: 'b1', rateType: 'HOURLY', amount: 5000, effectiveFrom: at('2026-01-01T00:00:00Z'), effectiveTo: null }]],
      ['b2', [{ staffProfileId: 'b2', rateType: 'HOURLY', amount: 6000, effectiveFrom: at('2026-01-01T00:00:00Z'), effectiveTo: null }]],
      ['r1', [{ staffProfileId: 'r1', rateType: 'HOURLY', amount: 2500, effectiveFrom: at('2026-01-01T00:00:00Z'), effectiveTo: null }]],
      ['r2', []],
    ]),
    claimedLineBySession: new Map(),
    coveragesByClient: new Map([
      ['cA', [{ _id: 'cov-A', clientId: 'cA', payerName: 'Acme Health', verificationStatus: 'VERIFIED', benefitOrder: 'PRIMARY', fundingSource: 'COMMERCIAL', effectiveFrom: at('2026-01-01T00:00:00Z') }]],
      ['cB', []],
    ]),
    roleByStaffId: new Map(),
    timeZone: TZ,
    window: { start: at('2026-09-07T04:00:00Z'), end: at('2026-09-14T04:00:00Z') },
    ...overrides,
  };
  return input;
}

/** The consolidated dataset exactly as previewCompanyBilling returns it. */
export function companyDataset(overrides = {}) {
  const agg = aggregateCompanyBilling(scenario(overrides));
  return {
    organization: { name: 'Demo ABA Clinic' },
    period: { label: '09/07/2026 – 09/13/2026', from: '2026-09-07', to: '2026-09-13', timeZone: TZ },
    generatedAt: '2026-09-14T14:00:00Z',
    ...agg,
  };
}
