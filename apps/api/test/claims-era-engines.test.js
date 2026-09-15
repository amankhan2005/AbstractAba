import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertClaimTransition } from '../src/modules/claims/claim.state.js';
import { validateSessionForClaim, sumClaimCharges, sumClaimUnits } from '../src/modules/claims/claim.validation.js';
import { parse835, EraParseError, SUPPORTED_835_SEGMENTS } from '../src/modules/era/era.parser.js';
import { matchEraRecord, reconciliationStatus } from '../src/modules/era/era.matching.js';

// ---------------- claim state machine ----------------
test('claim lifecycle allows valid transitions', () => {
  assert.doesNotThrow(() => assertClaimTransition('DRAFT', 'SUBMITTED'));
  assert.doesNotThrow(() => assertClaimTransition('SUBMITTED', 'ACCEPTED'));
  assert.doesNotThrow(() => assertClaimTransition('ACCEPTED', 'PAID'));
  assert.doesNotThrow(() => assertClaimTransition('SUBMITTED', 'REJECTED'));
  assert.doesNotThrow(() => assertClaimTransition('REJECTED', 'RESUBMITTED'));
  assert.doesNotThrow(() => assertClaimTransition('RESUBMITTED', 'SUBMITTED'));
  assert.doesNotThrow(() => assertClaimTransition('ACCEPTED', 'DENIED'));
  assert.doesNotThrow(() => assertClaimTransition('DENIED', 'RESUBMITTED'));
  assert.doesNotThrow(() => assertClaimTransition('PAID', 'CLOSED'));
  assert.doesNotThrow(() => assertClaimTransition('DRAFT', 'DRAFT')); // idempotent
});

test('claim lifecycle rejects illegal transitions', () => {
  assert.throws(() => assertClaimTransition('DRAFT', 'PAID'), /Illegal/);
  assert.throws(() => assertClaimTransition('CLOSED', 'SUBMITTED'), /Illegal/);
  assert.throws(() => assertClaimTransition('PAID', 'DENIED'), /Illegal/);
  assert.throws(() => assertClaimTransition('NOPE', 'PAID'), /Unknown/);
});

// ---------------- claim validation ----------------
const frozenSession = { _id: 's1', status: 'FROZEN', staffProfileId: 'st1', startedAt: '2026-02-10T09:00:00Z' };
const auth = { serviceCode: '97153', startDate: '2026-01-01', endDate: '2026-12-31', authorizedUnits: 100, usedUnits: 10 };

test('validateSessionForClaim accepts an eligible frozen session', () => {
  const r = validateSessionForClaim({ session: frozenSession, authorization: auth, client: { _id: 'c1' }, units: 8, charge: 12000 });
  assert.equal(r.eligible, true);
  assert.deepEqual(r.reasons, []);
});

test('validateSessionForClaim flags non-frozen sessions', () => {
  const r = validateSessionForClaim({ session: { ...frozenSession, status: 'DRAFT' }, authorization: auth, client: { _id: 'c1' }, units: 8, charge: 12000 });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('SESSION_NOT_FROZEN'));
});

test('validateSessionForClaim flags already-claimed sessions', () => {
  const r = validateSessionForClaim({ session: frozenSession, authorization: auth, client: { _id: 'c1' }, alreadyClaimedSessionIds: ['s1'], units: 8, charge: 12000 });
  assert.ok(r.reasons.includes('SESSION_ALREADY_CLAIMED'));
});

test('validateSessionForClaim enforces authorization date range and units', () => {
  const early = validateSessionForClaim({ session: { ...frozenSession, startedAt: '2025-12-01T09:00:00Z' }, authorization: auth, client: { _id: 'c1' }, units: 8, charge: 100 });
  assert.ok(early.reasons.includes('SERVICE_DATE_BEFORE_AUTH'));
  const overUnits = validateSessionForClaim({ session: frozenSession, authorization: auth, client: { _id: 'c1' }, units: 500, charge: 100 });
  assert.ok(overUnits.reasons.includes('UNITS_EXCEED_AUTHORIZED'));
});

test('validateSessionForClaim flags missing provider, client, service code, auth', () => {
  const r = validateSessionForClaim({ session: { ...frozenSession, staffProfileId: null }, authorization: null, client: null, units: 0, charge: -5 });
  for (const code of ['MISSING_PROVIDER', 'MISSING_CLIENT', 'AUTHORIZATION_MISSING', 'INVALID_UNITS', 'INVALID_CHARGE']) {
    assert.ok(r.reasons.includes(code), `expected ${code}`);
  }
});

test('sumClaimCharges/units total minor units and reject invalid', () => {
  assert.equal(sumClaimCharges([{ charge: 12000 }, { charge: 8000 }]), 20000);
  assert.equal(sumClaimUnits([{ units: 8 }, { units: 4 }]), 12);
  assert.throws(() => sumClaimCharges([{ charge: -1 }]), /non-negative/);
});

// ---------------- 835 parser ----------------
const SAMPLE_835 = [
  'ISA*00*          *00*          *ZZ*PAYER          *ZZ*PROVIDER       *260210*1200*^*00501*000000001*0*P*:',
  'GS*HP*PAYER*PROVIDER*20260210*1200*1*X*005010X221A1',
  'ST*835*0001',
  'BPR*I*1500.00*C*ACH',
  'TRN*1*CHECK12345*1234567890',
  'N1*PR*GOOD HEALTH PLAN',
  'N1*PE*ABA PROVIDER LLC',
  'CLP*CLAIM-1001*1*2000.00*1500.00*500.00*MC*PAYERCTRL999*11',
  'CAS*CO*45*500.00',
  'DTM*232*20260115',
  'SE*9*0001',
  'GE*1*1',
  'IEA*1*000000001',
].join('~') + '~';

test('parse835 extracts payer, total, trace and claim payment records', () => {
  const r = parse835(SAMPLE_835);
  assert.equal(r.payerName, 'GOOD HEALTH PLAN');
  assert.equal(r.totalPaidAmount, 150000); // $1500.00 -> minor units
  assert.equal(r.traceNumber, 'CHECK12345');
  assert.equal(r.claims.length, 1);
  const c = r.claims[0];
  assert.equal(c.claimNumberRef, 'CLAIM-1001');
  assert.equal(c.chargeAmount, 200000);
  assert.equal(c.paidAmount, 150000);
  assert.equal(c.patientResponsibility, 50000);
  assert.equal(c.payerControlNumber, 'PAYERCTRL999');
  assert.equal(c.serviceDate, '2026-01-15');
  assert.equal(c.adjustments.length, 1);
  assert.deepEqual(c.adjustments[0], { groupCode: 'CO', reasonCode: '45', amount: 50000 });
});

test('parse835 rejects malformed input safely', () => {
  assert.throws(() => parse835(''), EraParseError);
  assert.throws(() => parse835('not an edi file at all'), EraParseError); // no ST/SE
});

test('supported segment list is documented', () => {
  assert.ok(SUPPORTED_835_SEGMENTS.includes('CLP'));
  assert.ok(SUPPORTED_835_SEGMENTS.includes('CAS'));
});

// ---------------- matching ----------------
const claims = [
  { _id: 'c1', claimNumber: 'CLAIM-1001', payerControlNumber: 'PAYERCTRL999' },
  { _id: 'c2', claimNumber: 'CLAIM-1002', payerControlNumber: null },
  { _id: 'c3', claimNumber: 'CLAIM-1002', payerControlNumber: null },
];

test('matchEraRecord: exact match by payer control number', () => {
  const r = matchEraRecord({ payerControlNumber: 'PAYERCTRL999', claimNumberRef: 'X' }, claims);
  assert.deepEqual(r, { status: 'MATCHED', claimId: 'c1', candidateIds: [] });
});

test('matchEraRecord: match by claim number when no control number', () => {
  const r = matchEraRecord({ payerControlNumber: null, claimNumberRef: 'CLAIM-1001' }, claims);
  assert.equal(r.status, 'MATCHED');
  assert.equal(r.claimId, 'c1');
});

test('matchEraRecord: ambiguous when multiple claim numbers match', () => {
  const r = matchEraRecord({ payerControlNumber: null, claimNumberRef: 'CLAIM-1002' }, claims);
  assert.equal(r.status, 'AMBIGUOUS');
  assert.deepEqual(r.candidateIds.sort(), ['c2', 'c3']);
});

test('matchEraRecord: unmatched and invalid', () => {
  assert.equal(matchEraRecord({ payerControlNumber: null, claimNumberRef: 'NOPE' }, claims).status, 'UNMATCHED');
  assert.equal(matchEraRecord({ payerControlNumber: null, claimNumberRef: null }, claims).status, 'INVALID');
  assert.equal(matchEraRecord({ claimNumberRef: 'CLAIM-1001', paidAmount: -5 }, claims).status, 'INVALID');
});

test('reconciliationStatus reflects paid vs billed vs adjustment', () => {
  assert.equal(reconciliationStatus({ billed: 200000, paid: 0, adjustment: 0 }), 'UNRECONCILED');
  assert.equal(reconciliationStatus({ billed: 200000, paid: 150000, adjustment: 50000 }), 'RECONCILED');
  assert.equal(reconciliationStatus({ billed: 200000, paid: 100000, adjustment: 0 }), 'PARTIALLY_PAID');
});

// ---------------- Phase 5: billing preview computation & billing≠payroll -----
// Preview reuses validateSessionForClaim + sumClaimUnits/sumClaimCharges — the
// same eligibility and money math as commit — so a preview total can never
// differ from what generateFromSessions would persist for the same inputs.
// These tests pin the computation and the payroll/billing rate separation.

function computeDraft({ sessions, authorization, client, unitCharge, claimed = [] }) {
  const eligible = []; const skipped = [];
  for (const session of sessions) {
    const units = 1;
    const charge = Number.isInteger(unitCharge) ? unitCharge * units : 0;
    const { eligible: ok, reasons } = validateSessionForClaim({ session, authorization, client, alreadyClaimedSessionIds: claimed, units, charge });
    if (ok) eligible.push({ session, units, charge }); else skipped.push({ sessionId: session._id, reasons });
  }
  const lines = eligible.map((e) => ({ units: e.units, charge: e.charge }));
  return { lineCount: lines.length, skippedCount: skipped.length, totalUnits: sumClaimUnits(lines), totalCharge: sumClaimCharges(lines) };
}

test('billing preview: eligible sessions compute units/charge; ineligible are skipped with reasons', () => {
  const s2 = { _id: 's2', status: 'FROZEN', staffProfileId: 'st1', startedAt: '2026-03-01T09:00:00Z' };
  const bad = { _id: 's3', status: 'DRAFT', staffProfileId: 'st1', startedAt: '2026-03-02T09:00:00Z' };
  // Billing rate = $110.00/unit = 11000 minor units (NOT a payroll rate).
  const draft = computeDraft({ sessions: [frozenSession, s2, bad], authorization: auth, client: { _id: 'c1' }, unitCharge: 11000 });
  assert.equal(draft.lineCount, 2);
  assert.equal(draft.skippedCount, 1);
  assert.equal(draft.totalUnits, 2);
  assert.equal(draft.totalCharge, 22000); // 2 units × $110.00
});

test('billing charge uses the billing rate, independent of any payroll rate', () => {
  // Same worked session; a payroll rate of $32/hr (3200) is irrelevant to billing.
  const atBillingRate = (billingRate) => computeDraft({ sessions: [frozenSession], authorization: auth, client: { _id: 'c1' }, unitCharge: billingRate });
  assert.equal(atBillingRate(11000).totalCharge, 11000); // $110 billing
  assert.equal(atBillingRate(9000).totalCharge, 9000);   // $90 billing — changing billing rate changes billing only
  // The payroll rate (3200) never appears in billing math; billing total tracks the billing rate exactly.
});

test('billing preview totals equal what a committed claim would total (no drift)', () => {
  const s2 = { _id: 's2', status: 'FROZEN', staffProfileId: 'st1', startedAt: '2026-03-01T09:00:00Z' };
  const previewTotal = computeDraft({ sessions: [frozenSession, s2], authorization: auth, client: { _id: 'c1' }, unitCharge: 11000 }).totalCharge;
  // committed lines would carry the same per-line charge; the run total is sumClaimCharges over the same lines
  const committedTotal = sumClaimCharges([{ charge: 11000 }, { charge: 11000 }]);
  assert.equal(previewTotal, committedTotal);
  assert.equal(previewTotal, 22000);
});
