import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateChildBilling, aggregateCompanyBilling, resolvePayer, authorizationIdFor, civilKey, hourlyRateFor, allocateCents, BILLING_ISSUES } from '../src/modules/claims/billing.aggregate.js';
import { scenario, TZ } from './_billing-fixture.js';

/**
 * INSURANCE BILLING ENGINE (pure). A completed session is billing-ready
 * automatically: actual worked minutes (SessionTimeRecord) ÷ 60 × the
 * clinician's hourly rate (Staff Profile PayRate), BCBA and RBT separately,
 * rounded to the cent once per clinician. No manual review, no authorization rate.
 */
const at = (iso) => new Date(iso);
const only = (ids, overrides = {}) => { const base = scenario(overrides); base.sessions = base.sessions.filter((s) => ids.includes(s._id)); return base; };
const rowsOf = (input) => aggregateChildBilling(input).sessions;
const codes = (row) => row.issues.map((r) => r.code);
const charge = (minutes, rateCents) => {
  const base = only(['s1'], { workedById: new Map([['s1', minutes]]), payRatesByStaffId: new Map([['b1', [{ rateType: 'HOURLY', amount: rateCents, effectiveFrom: at('2026-01-01T00:00:00Z') }]]]) });
  return aggregateChildBilling(base).summary.bcbaCharge;
};

test('1–5 · a completed session is READY automatically — authorizations have no rate and none is required', () => {
  const [r] = rowsOf(only(['s1']));
  assert.equal(r.billingStatus, 'READY');
  assert.deepEqual(r.issues, []);
  assert.equal(r.hourlyRate, 5000);
  assert.equal(r.amount, 10000); // 120 min at $50/hr
  assert.equal(r.authorizationNumber, 'AUTH-2002');
  assert.equal(r.authorizationId, 'svc:A2', 'resolved by internal id');
  assert.ok(!('unitPrice' in r), 'no authorization unit price in the billing model');
  assert.ok(!Object.keys(BILLING_ISSUES).some((k) => /UNIT_PRICE|BILLING_RATE|BILLING_CODE|REMAINING_UNITS/.test(k)), 'authorization rate / unit / code checks are gone');
  // A SUBMITTED session (clinician completed, clinical sign-off pending) is ready too.
  const [submitted] = rowsOf(only(['s1'], { sessions: scenario().sessions.filter((s) => s._id === 's1').map((s) => ({ ...s, status: 'SUBMITTED' })) }));
  assert.equal(submitted.billingStatus, 'READY');
});

test('8 · hourly rate from the Staff Profile PayRate: effective-dated, first recorded rate when it was added after the session', () => {
  const rates = [
    { rateType: 'HOURLY', amount: 4000, effectiveFrom: at('2026-01-01T00:00:00Z'), effectiveTo: at('2026-08-31T00:00:00Z') },
    { rateType: 'HOURLY', amount: 5000, effectiveFrom: at('2026-09-01T00:00:00Z'), effectiveTo: null },
  ];
  assert.equal(hourlyRateFor(rates, at('2026-08-15T12:00:00Z')), 4000);
  assert.equal(hourlyRateFor(rates, at('2026-09-12T13:00:00Z')), 5000);
  assert.equal(hourlyRateFor([{ rateType: 'HOURLY', amount: 2500, effectiveFrom: at('2026-09-16T00:00:00Z') }], at('2026-09-12T13:00:00Z')), 2500, 'rate entered on the profile after the session');
  assert.equal(hourlyRateFor([{ rateType: 'PER_SESSION', amount: 9000, effectiveFrom: at('2026-01-01T00:00:00Z') }], at('2026-09-12T13:00:00Z')), null, 'only HOURLY rates bill');
  assert.equal(hourlyRateFor([], at('2026-09-12T13:00:00Z')), null);
});

test('9–13 · actual worked minutes → fractional hours × hourly rate, rounded to the cent once', () => {
  assert.equal(charge(360, 5000), 30000); // 6h × $50 = $300.00
  assert.equal(charge(390, 5000), 32500); // 6.5h × $50 = $325.00
  assert.equal(charge(7, 2500), 292); //    0.1166…h × $25 = $2.92
  assert.equal(charge(404, 5000), 33667); // 6h 44m × $50 = $336.67
  assert.equal(charge(0, 5000), 0);
  const [r] = rowsOf(only(['s1'], { workedById: new Map([['s1', 404]]) }));
  assert.equal(r.workedMinutes, 404, 'SessionTimeRecord minutes, not the appointment');
  assert.equal(r.workedHours, 404 / 60);
});

test('14–16 · BCBA and RBT calculated independently; multiple sessions aggregate; each clinician uses their own rate', () => {
  const minutes = new Map([['m1', 90], ['m2', 120], ['m3', 45], ['m4', 7]]);
  const base = scenario({ workedById: minutes, apptById: new Map([['a', { bcbaId: 'b1', rbtId: 'r1' }]]) });
  base.sessions = [
    { _id: 'm1', clientId: 'cA', staffProfileId: 'b1', appointmentId: 'a', status: 'FROZEN', startedAt: at('2026-09-08T13:00:00Z'), selectedAuthorizationIds: ['svc:A2'] },
    { _id: 'm2', clientId: 'cA', staffProfileId: 'b1', appointmentId: 'a', status: 'FROZEN', startedAt: at('2026-09-09T13:00:00Z'), selectedAuthorizationIds: ['svc:A2'] },
    { _id: 'm3', clientId: 'cA', staffProfileId: 'b1', appointmentId: 'a', status: 'FROZEN', startedAt: at('2026-09-10T13:00:00Z'), selectedAuthorizationIds: ['svc:A2'] },
    { _id: 'm4', clientId: 'cA', staffProfileId: 'r1', appointmentId: 'a', status: 'FROZEN', startedAt: at('2026-09-10T16:00:00Z'), selectedAuthorizationIds: ['svc:A1'] },
  ];
  const { staff, summary, sessions } = aggregateChildBilling(base);
  const ben = staff.find((s) => s.staffName === 'Ben Carter');
  assert.deepEqual([ben.role, ben.sessions, ben.workedMinutes, ben.hourlyRate, ben.charge], ['BCBA', 3, 255, 5000, 21250]); // 4h 15m × $50 = $212.50
  const ann = staff.find((s) => s.staffName === 'Ann Lee');
  assert.deepEqual([ann.role, ann.workedMinutes, ann.hourlyRate, ann.charge], ['RBT', 7, 2500, 292]);
  assert.deepEqual([summary.bcbaCharge, summary.rbtCharge, summary.totalCharge], [21250, 292, 21542]);
  assert.equal(sessions.filter((r) => r.role === 'BCBA').reduce((t, r) => t + r.amount, 0), 21250, 'session amounts reconcile to the clinician charge');
  // Combining BCBA + RBT time would give a different (wrong) number — never done.
  assert.notEqual(summary.totalCharge, Math.round(((255 + 7) / 60) * 5000));
});

test('17–18 · a missing hourly rate is INCOMPLETE billing data (never a fake $0.00) and becomes READY once the rate exists', () => {
  const noRate = only(['s1'], { payRatesByStaffId: new Map() });
  const [r] = rowsOf(noRate);
  assert.equal(r.billingStatus, 'INCOMPLETE');
  assert.deepEqual(codes(r), ['MISSING_HOURLY_RATE']);
  assert.equal(r.amount, null);
  assert.equal(aggregateChildBilling(noRate).summary.totalCharge, 0);
  const withRate = only(['s1'], { payRatesByStaffId: new Map([['b1', [{ rateType: 'HOURLY', amount: 5000, effectiveFrom: at('2026-09-16T00:00:00Z') }]]]) });
  assert.equal(rowsOf(withRate)[0].billingStatus, 'READY');
});

test('19–20 · client total = BCBA + RBT; company total = Σ client totals', () => {
  const { clients, summary } = aggregateCompanyBilling(scenario());
  const john = clients.find((c) => c.clientName === 'John Doe');
  assert.deepEqual(john.bcbaStaff.map((s) => [s.staffName, s.hourlyRate, s.workedMinutes, s.charge]), [['Ben Carter', 5000, 120, 10000], ['Ellen Ng', 6000, 60, 6000]]);
  assert.deepEqual(john.rbtStaff.map((s) => [s.staffName, s.hourlyRate, s.workedMinutes, s.charge]), [['Ann Lee', 2500, 150, 6250]]);
  assert.deepEqual([john.bcbaCharge, john.rbtCharge, john.clientTotal], [16000, 6250, 22250]);
  const amy = clients.find((c) => c.clientName === 'Amy Ray');
  assert.deepEqual([amy.clientTotal, amy.incompleteCount], [0, 1]);
  assert.deepEqual(amy.issues.map((i) => [i.code, i.count, i.staff]), [['MISSING_HOURLY_RATE', 1, ['David Brown']], ['MISSING_PAYER', 1, ['David Brown']]]);
  assert.equal(summary.totalBillableAmount, clients.reduce((t, c) => t + c.clientTotal, 0));
  assert.deepEqual([summary.totalBillableAmount, summary.readyToBill, summary.incomplete], [22250, 3, 1]);
});

test('22 · authorization validity and date rules still apply (inclusive, org calendar)', () => {
  const auth = (patch) => { const m = scenario().authById; m.set('svc:A2', { ...m.get('svc:A2'), ...patch }); return m; };
  const first = (overrides, sessionPatch = {}) => { const b = only(['s1'], overrides); b.sessions = b.sessions.map((s) => ({ ...s, ...sessionPatch })); return rowsOf(b)[0]; };
  assert.deepEqual(codes(first({}, { selectedAuthorizationIds: [], selectedAuthorizationId: null })), ['AUTHORIZATION_NOT_SELECTED']);
  assert.deepEqual(codes(first({}, { selectedAuthorizationIds: ['svc:GONE'] })), ['AUTHORIZATION_NOT_FOUND']);
  assert.deepEqual(codes(first({ authById: auth({ deletedAt: new Date() }) })), ['AUTHORIZATION_ARCHIVED']);
  assert.deepEqual(codes(first({ authById: auth({ status: 'DENIED' }) })), ['AUTHORIZATION_DENIED']);
  assert.deepEqual(codes(first({ authById: auth({ clientId: 'other' }) })), ['AUTHORIZATION_CLIENT_MISMATCH']);
  assert.deepEqual(codes(first({ authById: auth({ endDate: at('2026-09-11T00:00:00Z') }) })), ['AUTHORIZATION_EXPIRED']);
  assert.deepEqual(codes(first({ authById: auth({ startDate: at('2026-09-13T00:00:00Z') }) })), ['AUTHORIZATION_NOT_STARTED']);
  assert.equal(first({ authById: auth({ billingCode: null, status: 'NOT_SENT' }) }).billingStatus, 'READY', 'no billing code and a payer status of Not sent do not block');
  // 11:30 PM New York on 12/31 is 01/01 in UTC — still inside a 12/31 end date.
  const late = first({}, { startedAt: at('2027-01-01T04:30:00Z') });
  assert.deepEqual([late.serviceDate, late.billingStatus], ['2026-12-31', 'READY']);
  assert.equal(civilKey(at('2026-09-01T03:59:00Z'), TZ), '2026-08-31');
});

test('insurance: saved (unverified or verified) insurance in force is usable; failed, lapsed, private pay and none explain themselves', () => {
  const cov = (patch) => [{ payerName: 'Acme', verificationStatus: 'VERIFIED', fundingSource: 'COMMERCIAL', benefitOrder: 'PRIMARY', ...patch }];
  assert.equal(resolvePayer(cov({}), '2026-09-12').payerName, 'Acme');
  assert.equal(resolvePayer(cov({ verificationStatus: 'UNVERIFIED' }), '2026-09-12').payerName, 'Acme', 'no manual verification step is required');
  assert.deepEqual(resolvePayer(cov({ verificationStatus: 'FAILED' }), '2026-09-12'), { reason: 'INSURANCE_NOT_ACTIVE' });
  assert.deepEqual(resolvePayer(cov({ effectiveTo: at('2026-09-11T00:00:00Z') }), '2026-09-12'), { reason: 'COVERAGE_NOT_EFFECTIVE' });
  assert.deepEqual(resolvePayer(cov({ fundingSource: 'PRIVATE_PAY' }), '2026-09-12'), { reason: 'PRIVATE_PAY' });
  assert.deepEqual(resolvePayer([], '2026-09-12'), { reason: 'MISSING_PAYER' });
});

test('population: an unbilled AMENDED (superseded) session is not billed; an already-billed session shows its claim amount', () => {
  const amended = only(['s1']); amended.sessions = amended.sessions.map((s) => ({ ...s, status: 'AMENDED' }));
  assert.equal(rowsOf(amended).length, 0);
  const [billed] = rowsOf(only(['s1'], { claimedLineBySession: new Map([['s1', { charge: 9999, hourlyRate: 5000, claimId: 'c1', claimNumber: 'CLM-1' }]]) }));
  assert.deepEqual([billed.billingStatus, billed.amount, billed.claimNumber], ['BILLED', 9999, 'CLM-1']);
});

test('supporting rules: authorization resolution, cent allocation, role fallback, no stray rate inputs', () => {
  assert.equal(authorizationIdFor({ selectedAuthorizationIds: ['svc:X'] }, { authorizationIds: ['svc:Z'] }), 'svc:X');
  assert.equal(authorizationIdFor({}, { authorizationIds: ['svc:Z'] }), 'svc:Z');
  assert.equal(authorizationIdFor({}, { authorizationIds: ['svc:Z', 'svc:W'] }), null);
  const parts = allocateCents(33667, [45, 45, 45, 45, 45, 45, 45, 45, 44]);
  parts.forEach((p, i) => assert.ok(Math.abs(p - (33667 * [45, 45, 45, 45, 45, 45, 45, 45, 44][i]) / 404) < 1, 'each part within a cent of its share'));
  assert.equal(allocateCents(33667, [45, 45, 45, 45, 45, 45, 45, 45, 44]).reduce((t, v) => t + v, 0), 33667);
  const base = only(['s3'], { apptById: new Map([['ap3', { bcbaId: null, rbtId: null }]]), roleByStaffId: new Map([['r1', 'RBT']]) });
  assert.equal(rowsOf(base)[0].role, 'RBT');
  assert.equal(aggregateCompanyBilling({ window: {} }).summary.totalBillableAmount, 0);
});
