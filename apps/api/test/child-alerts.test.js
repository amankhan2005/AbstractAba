import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChildAlerts, alertsSummary } from '../src/modules/clients/clients.alerts.js';

const NOW = new Date('2026-08-25T00:00:00Z');
// A fully-healthy child: complete intake, both auths approved & far from expiry,
// BCBA+RBT assigned, capacity comfortably under approved.
const healthy = {
  now: NOW,
  intakeWorkflowStatus: 'COMPLETE',
  approvedWeeklyHours: 30,
  assignedWeeklyHours: 20,
  careTeam: [{ role: 'BCBA', status: 'ACTIVE' }, { role: 'RBT', status: 'ACTIVE' }],
  serviceAuthorizations: [
    { serviceType: 'FBA', status: 'APPROVED', endDate: '2026-12-31' },
    { serviceType: 'ABA', status: 'APPROVED', endDate: '2026-12-31' },
  ],
};

const codes = (alerts) => alerts.map((a) => a.code);

test('a healthy child produces no alerts', () => {
  assert.deepEqual(computeChildAlerts(healthy), []);
  assert.deepEqual(alertsSummary([]), { total: 0, severity: null });
});

test('incomplete intake with missing documents is CRITICAL', () => {
  const a = computeChildAlerts({ ...healthy, intakeWorkflowStatus: 'MISSING_DOCUMENTS' });
  const intake = a.find((x) => x.code === 'INTAKE_INCOMPLETE');
  assert.ok(intake);
  assert.equal(intake.severity, 'CRITICAL');
  assert.equal(intake.action, 'overview');
});

test('unsent FBA and denied ABA each raise the right alert', () => {
  const a = computeChildAlerts({ ...healthy, serviceAuthorizations: [
    { serviceType: 'FBA', status: 'NOT_SENT' },
    { serviceType: 'ABA', status: 'DENIED' },
  ] });
  assert.ok(codes(a).includes('FBA_PENDING'));
  const denied = a.find((x) => x.code === 'ABA_DENIED');
  assert.equal(denied.severity, 'CRITICAL');
  assert.equal(denied.action, 'authorizations');
});

test('saving is not approval: no authorization is MISSING, a saved NOT_SENT one is only an INFO follow-up', () => {
  const none = computeChildAlerts({ ...healthy, serviceAuthorizations: [{ serviceType: 'ABA', status: 'APPROVED', endDate: '2026-12-31' }] });
  const missing = none.find((x) => x.code === 'FBA_MISSING');
  assert.equal(missing.severity, 'WARNING');
  assert.equal(missing.message, 'No FBA authorization on file.');
  assert.ok(!codes(none).includes('FBA_PENDING'));

  const saved = computeChildAlerts({ ...healthy, serviceAuthorizations: [
    { serviceType: 'FBA', status: 'NOT_SENT', endDate: '2026-12-31' },
    { serviceType: 'ABA', status: 'APPROVED', endDate: '2026-12-31' },
  ] });
  const pending = saved.find((x) => x.code === 'FBA_PENDING');
  assert.equal(pending.severity, 'INFO');
  assert.match(pending.message, /saved/);
  assert.ok(!codes(saved).includes('FBA_MISSING'));
});

test('the most recently added authorization of a type drives its alert', () => {
  const a = computeChildAlerts({ ...healthy, serviceAuthorizations: [
    { serviceType: 'FBA', status: 'DENIED', createdAt: '2026-07-01T00:00:00Z' },
    { serviceType: 'FBA', status: 'NOT_SENT', createdAt: '2026-08-20T00:00:00Z', endDate: '2026-12-31' },
    { serviceType: 'ABA', status: 'APPROVED', endDate: '2026-12-31' },
  ] });
  assert.ok(!codes(a).includes('FBA_DENIED'));
  assert.ok(codes(a).includes('FBA_PENDING'));
});

test('authorization expiring within 30 days is a WARNING; expired is CRITICAL', () => {
  const expiring = computeChildAlerts({ ...healthy, serviceAuthorizations: [
    { serviceType: 'FBA', status: 'APPROVED', endDate: '2026-09-10' }, // ~16 days out
    { serviceType: 'ABA', status: 'APPROVED', endDate: '2026-12-31' },
  ] });
  const w = expiring.find((x) => x.code === 'FBA_EXPIRING');
  assert.ok(w); assert.equal(w.severity, 'WARNING');

  const expired = computeChildAlerts({ ...healthy, serviceAuthorizations: [
    { serviceType: 'FBA', status: 'APPROVED', endDate: '2026-08-01' }, // past
    { serviceType: 'ABA', status: 'APPROVED', endDate: '2026-12-31' },
  ] });
  const c = expired.find((x) => x.code === 'FBA_EXPIRED');
  assert.ok(c); assert.equal(c.severity, 'CRITICAL');
});

test('missing care team and missing BCBA raise assignment alerts', () => {
  const none = computeChildAlerts({ ...healthy, careTeam: [] });
  assert.ok(codes(none).includes('ASSIGNMENT_MISSING'));
  const noBcba = computeChildAlerts({ ...healthy, careTeam: [{ role: 'RBT', status: 'ACTIVE' }] });
  assert.ok(codes(noBcba).includes('BCBA_MISSING'));
});

test('capacity exceeded is CRITICAL; nearing (>=90%) is INFO', () => {
  const over = computeChildAlerts({ ...healthy, approvedWeeklyHours: 20, assignedWeeklyHours: 24 });
  const c = over.find((x) => x.code === 'CAPACITY_EXCEEDED');
  assert.ok(c); assert.equal(c.severity, 'CRITICAL');

  const near = computeChildAlerts({ ...healthy, approvedWeeklyHours: 20, assignedWeeklyHours: 19 });
  assert.ok(codes(near).includes('CAPACITY_NEARING'));
});

test('alertsSummary reports the highest severity present', () => {
  const a = computeChildAlerts({ ...healthy, intakeWorkflowStatus: 'MISSING_DOCUMENTS', careTeam: [{ role: 'RBT', status: 'ACTIVE' }] });
  const s = alertsSummary(a);
  assert.equal(s.severity, 'CRITICAL'); // intake missing-docs
  assert.ok(s.total >= 2);
});
