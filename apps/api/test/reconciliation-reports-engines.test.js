import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReconciliation, detectClaimDiscrepancies, collectionRate, sumMinor } from '../src/modules/reconciliation/reconciliation.engine.js';
import { assertReconciliationTransition } from '../src/modules/reconciliation/reconciliation.state.js';
import { resolveDateRange, ageBuckets } from '../src/modules/reports/reports.dates.js';
import { toCsv } from '../src/modules/reports/reports.csv.js';

// ---------------- reconciliation engine ----------------
test('computeReconciliation: full payment => RECONCILED', () => {
  const r = computeReconciliation({ billedAmount: 100000, paidAmount: 80000, adjustmentAmount: 20000 });
  assert.equal(r.remainingAmount, 0);
  assert.equal(r.status, 'RECONCILED');
});
test('computeReconciliation: partial payment => PARTIAL', () => {
  const r = computeReconciliation({ billedAmount: 100000, paidAmount: 40000, adjustmentAmount: 0 });
  assert.equal(r.remainingAmount, 60000);
  assert.equal(r.status, 'PARTIAL');
});
test('computeReconciliation: no payment => UNRECONCILED', () => {
  const r = computeReconciliation({ billedAmount: 100000, paidAmount: 0, adjustmentAmount: 0 });
  assert.equal(r.status, 'UNRECONCILED');
});
test('computeReconciliation: overpayment => DISCREPANCY with OVERPAYMENT flag', () => {
  const r = computeReconciliation({ billedAmount: 100000, paidAmount: 120000, adjustmentAmount: 0 });
  assert.equal(r.status, 'DISCREPANCY');
  assert.equal(r.remainingAmount, -20000);
  assert.ok(r.flags.includes('OVERPAYMENT'));
});
test('computeReconciliation: excess adjustment => DISCREPANCY', () => {
  const r = computeReconciliation({ billedAmount: 100000, paidAmount: 0, adjustmentAmount: 120000 });
  assert.equal(r.status, 'DISCREPANCY');
  assert.ok(r.flags.includes('EXCESS_ADJUSTMENT'));
});
test('computeReconciliation rejects floats/negatives', () => {
  assert.throws(() => computeReconciliation({ billedAmount: 1.5, paidAmount: 0, adjustmentAmount: 0 }), /minor units/);
  assert.throws(() => computeReconciliation({ billedAmount: -1, paidAmount: 0, adjustmentAmount: 0 }), /minor units/);
});

test('detectClaimDiscrepancies flags paid-total mismatch, duplicate remittance, overpayment', () => {
  const mismatch = detectClaimDiscrepancies({ claim: { paidAmount: 5000, totalCharge: 10000, adjustmentAmount: 0 }, eraPayments: [{ paidAmount: 6000 }] });
  assert.ok(mismatch.includes('PAID_TOTAL_MISMATCH'));
  const dup = detectClaimDiscrepancies({ claim: { paidAmount: 0, totalCharge: 100 }, postedPaymentIds: ['p1', 'p1'] });
  assert.ok(dup.includes('DUPLICATE_REMITTANCE'));
  const over = detectClaimDiscrepancies({ claim: { paidAmount: 15000, totalCharge: 10000, adjustmentAmount: 0 } });
  assert.ok(over.includes('OVERPAYMENT'));
  const clean = detectClaimDiscrepancies({ claim: { paidAmount: 8000, totalCharge: 10000, adjustmentAmount: 0 }, eraPayments: [{ paidAmount: 8000 }], postedPaymentIds: ['p1'] });
  assert.deepEqual(clean, []);
});

test('collectionRate and sumMinor', () => {
  assert.equal(collectionRate({ billed: 100000, collected: 75000 }), 75);
  assert.equal(collectionRate({ billed: 0, collected: 0 }), 0);
  assert.equal(sumMinor([100, 200, 300]), 600);
  assert.throws(() => sumMinor([1.2]), /integer/);
});

// ---------------- reconciliation state machine ----------------
test('reconciliation transitions enforce workflow', () => {
  assert.doesNotThrow(() => assertReconciliationTransition('UNRECONCILED', 'REVIEWING'));
  assert.doesNotThrow(() => assertReconciliationTransition('REVIEWING', 'RECONCILED'));
  assert.doesNotThrow(() => assertReconciliationTransition('DISCREPANCY', 'RESOLVED'));
  assert.throws(() => assertReconciliationTransition('RECONCILED', 'REVIEWING'), /Illegal/);
  assert.throws(() => assertReconciliationTransition('UNRECONCILED', 'RESOLVED'), /Illegal/);
});

// ---------------- date ranges ----------------
const NOW = new Date('2026-02-17T12:00:00Z'); // a Tuesday
test('resolveDateRange presets', () => {
  assert.deepEqual(resolveDateRange({ preset: 'this_month' }, NOW), { from: new Date('2026-02-01T00:00:00Z'), to: new Date('2026-03-01T00:00:00Z') });
  assert.deepEqual(resolveDateRange({ preset: 'last_month' }, NOW), { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z') });
  assert.deepEqual(resolveDateRange({ preset: 'this_quarter' }, NOW), { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-04-01T00:00:00Z') });
  const today = resolveDateRange({ preset: 'today' }, NOW);
  assert.equal(today.from.toISOString(), '2026-02-17T00:00:00.000Z');
});
test('resolveDateRange custom validation', () => {
  assert.throws(() => resolveDateRange({ preset: 'custom', start: '2026-02-10', end: '2026-02-01' }), /after start/);
  assert.throws(() => resolveDateRange({ preset: 'custom', start: 'bad', end: 'worse' }), /Invalid/);
  const ok = resolveDateRange({ preset: 'custom', start: '2026-02-01', end: '2026-02-10' });
  assert.equal(ok.from.toISOString(), '2026-02-01T00:00:00.000Z');
});

// ---------------- aging ----------------
test('ageBuckets sorts amounts into 0-30/31-60/61-90/90+', () => {
  const items = [
    { amount: 1000, date: '2026-02-10' }, // 7 days -> current
    { amount: 2000, date: '2026-01-10' }, // ~38 days -> 31-60
    { amount: 3000, date: '2025-12-10' }, // ~69 days -> 61-90
    { amount: 4000, date: '2025-10-01' }, // >90 -> 90+
  ];
  const b = ageBuckets(items, NOW);
  assert.equal(b.current, 1000);
  assert.equal(b.d31_60, 2000);
  assert.equal(b.d61_90, 3000);
  assert.equal(b.d90_plus, 4000);
  assert.equal(b.total, 10000);
});

// ---------------- CSV ----------------
test('toCsv escapes commas, quotes, newlines', () => {
  const csv = toCsv(['a', 'b'], [['plain', 'has,comma'], ['has"quote', 'has\nnewline']]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'a,b');
  assert.equal(lines[1], 'plain,"has,comma"');
  assert.equal(lines[2], '"has""quote","has\nnewline"');
});
