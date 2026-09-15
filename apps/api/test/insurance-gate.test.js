import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCoverage,
  coverageEffectiveOn,
  reverificationOverdue,
} from '../src/modules/clients/insuranceGate.js';
import { INSURANCE_VERIFICATION_STATUS, COVERAGE_SATISFIED } from '../src/models/enums.js';

/**
 * ---------------------------------------------------------------------------
 * INSURANCE VERIFICATION GATE — blueprint §6.2.
 *
 * "Nothing further can proceed until insurance is verified, and the pipeline
 * says so."
 *
 * Two halves, both tested here: the gate must BLOCK, and it must EXPLAIN. A
 * refusal a receptionist cannot act on has only moved the work to a phone call.
 *
 * §6.9 bounds the scope: "version one records verification; version 1.5
 * automates the transaction." So this evaluates a verification a person
 * performed. There is no simulated eligibility transaction here, because
 * inventing one would be inventing a capability the clinic does not have.
 * ---------------------------------------------------------------------------
 */

const AUGUST = new Date('2026-08-15T10:00:00Z');

const coverage = (over = {}) => ({
  _id: 'cov-1',
  fundingSource: 'COMMERCIAL',
  verificationStatus: 'VERIFIED',
  benefitOrder: 'PRIMARY',
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: new Date('2026-12-31'),
  reverificationDueAt: null,
  deletedAt: null,
  ...over,
});

// --- the gate opens ---------------------------------------------------------

test('verified, in-force coverage opens the gate', () => {
  const result = evaluateCoverage([coverage()], { when: AUGUST });
  assert.equal(result.satisfied, true);
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.reason, null, 'an open gate needs no explanation');
});

test('a verified SECONDARY alone still opens the gate', () => {
  // Secondary coverage is real coverage. Requiring a primary would block care
  // for families whose only cover happens to be recorded as secondary.
  const result = evaluateCoverage([coverage({ benefitOrder: 'SECONDARY' })], { when: AUGUST });
  assert.equal(result.satisfied, true);
});

test('PRIVATE_PAY needs no payer verification', () => {
  // There is no payer to verify with. Gating a family paying directly would
  // block care for a reason that does not apply to them.
  const result = evaluateCoverage(
    [coverage({ fundingSource: 'PRIVATE_PAY', verificationStatus: 'UNVERIFIED' })],
    { when: AUGUST },
  );
  assert.equal(result.satisfied, true);
  assert.equal(result.status, 'PRIVATE_PAY');
});

test('one good coverage opens the gate even beside a failed one', () => {
  const result = evaluateCoverage(
    [coverage({ _id: 'bad', verificationStatus: 'FAILED' }), coverage({ _id: 'good' })],
    { when: AUGUST },
  );
  assert.equal(result.satisfied, true);
  assert.equal(result.coverageId, 'good');
});

// --- the gate closes --------------------------------------------------------

test('REGRESSION — no coverage on file closes the gate', () => {
  const result = evaluateCoverage([], { when: AUGUST });
  assert.equal(result.satisfied, false);
  assert.equal(result.status, 'NO_COVERAGE');
  assert.match(result.reason, /insurance details/i);
});

test('REGRESSION — every non-verified status closes the gate', () => {
  for (const status of INSURANCE_VERIFICATION_STATUS.filter((s) => s !== COVERAGE_SATISFIED)) {
    const result = evaluateCoverage([coverage({ verificationStatus: status })], { when: AUGUST });
    assert.equal(result.satisfied, false, `${status} must not open the gate`);
    assert.ok(result.reason, `${status} must explain itself`);
  }
});

test('REGRESSION — verified but LAPSED coverage closes the gate', () => {
  // The verification was true when it was made and is not true now. Effective
  // dating exists precisely to express that difference; treating a stale
  // VERIFIED as current is how care gets delivered against dead cover.
  const lapsed = coverage({ effectiveTo: new Date('2026-06-30') });
  const result = evaluateCoverage([lapsed], { when: AUGUST });
  assert.equal(result.satisfied, false);
  assert.equal(result.status, 'EXPIRED');
  assert.match(result.reason, /checked again/i);
});

test('REGRESSION — coverage not yet in force closes the gate', () => {
  const future = coverage({ effectiveFrom: new Date('2026-10-01') });
  assert.equal(evaluateCoverage([future], { when: AUGUST }).satisfied, false);
});

test('REGRESSION — an overdue re-verification closes the gate', () => {
  // §6.9 lists re-verification prompts as part of the verification record.
  const stale = coverage({ reverificationDueAt: new Date('2026-07-01') });
  const result = evaluateCoverage([stale], { when: AUGUST });
  assert.equal(result.satisfied, false);
  assert.equal(result.status, 'EXPIRED');
});

test('a soft-deleted coverage record is ignored entirely', () => {
  const result = evaluateCoverage([coverage({ deletedAt: new Date() })], { when: AUGUST });
  assert.equal(result.satisfied, false);
  assert.equal(result.status, 'NO_COVERAGE');
});

// --- the gate explains itself ----------------------------------------------

test('the most ACTIONABLE failure is reported, not the first one found', () => {
  // A mistyped member id is fixable at the front desk in a minute; a
  // terminated policy is not. Reporting whichever happened to be stored first
  // is how the fixable one gets lost in the queue.
  const result = evaluateCoverage(
    [coverage({ _id: 'a', verificationStatus: 'FAILED' }),
      coverage({ _id: 'b', verificationStatus: 'NEEDS_CORRECTION' })],
    { when: AUGUST },
  );
  assert.equal(result.status, 'NEEDS_CORRECTION');
  assert.equal(result.coverageId, 'b');
});

test('every refusal is plain language — no code, field name or enum', () => {
  for (const status of INSURANCE_VERIFICATION_STATUS.filter((s) => s !== COVERAGE_SATISFIED)) {
    const { reason } = evaluateCoverage([coverage({ verificationStatus: status })], { when: AUGUST });
    assert.doesNotMatch(reason, /tenantId|clientId|422|INSURANCE-|Mongo|UNVERIFIED|NEEDS_CORRECTION/);
    assert.match(reason, /^[A-Z]/, 'reads as a sentence');
    assert.match(reason, /\.$/, 'ends as a sentence');
  }
  assert.match(
    evaluateCoverage([], { when: AUGUST }).reason,
    /before scheduling/i,
    'says what to do next, not merely what is wrong',
  );
});

// --- date helpers -----------------------------------------------------------

test('effective dating treats open-ended coverage as in force', () => {
  assert.equal(coverageEffectiveOn({ effectiveFrom: null, effectiveTo: null }, AUGUST), true);
  assert.equal(coverageEffectiveOn({ effectiveFrom: new Date('2026-01-01'), effectiveTo: null }, AUGUST), true);
});

test('re-verification is not overdue when no date is set', () => {
  assert.equal(reverificationOverdue({ reverificationDueAt: null }, AUGUST), false);
  assert.equal(reverificationOverdue({ reverificationDueAt: new Date('2026-12-01') }, AUGUST), false);
  assert.equal(reverificationOverdue({ reverificationDueAt: new Date('2026-01-01') }, AUGUST), true);
});

test('the gate is evaluated on the DATE OF SERVICE, not today', () => {
  // Booking in September against cover that ends in August must be refused
  // even though the cover is live at the moment of booking.
  const ending = coverage({ effectiveTo: new Date('2026-08-31') });
  assert.equal(evaluateCoverage([ending], { when: new Date('2026-08-20') }).satisfied, true);
  assert.equal(evaluateCoverage([ending], { when: new Date('2026-09-20') }).satisfied, false);
});
