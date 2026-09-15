import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectStaffActivity, roleForSession, minutesBetween } from '../src/modules/activity/activity.projection.js';

/**
 * ONE authoritative staff-activity projection (pipeline re-architecture, spec
 * §3–§5). DB-free: this is the single normalization Payroll and Billing both
 * consume, so its correctness is what guarantees the two surfaces can never
 * disagree about who worked, in what role, for how long, or at what rate.
 */

const apptById = new Map([
  ['ap-b', { _id: 'ap-b', bcbaId: 'BCBA-TEST', rbtId: null, startAt: new Date('2026-09-04T13:00:00Z'), endAt: new Date('2026-09-04T14:30:00Z'), timeSet: true }],
  ['ap-r', { _id: 'ap-r', bcbaId: null, rbtId: 'RBT-TEST', startAt: new Date('2026-09-04T14:00:00Z'), endAt: new Date('2026-09-04T16:00:00Z'), timeSet: true }],
  ['ap-x', { _id: 'ap-x', bcbaId: null, rbtId: null }], // review-frozen: no role on appt
]);
const staffById = new Map([
  ['BCBA-TEST', { _id: 'BCBA-TEST', firstName: 'Sarah', middleName: 'Jane', lastName: 'Smith' }],
  ['RBT-TEST', { _id: 'RBT-TEST', firstName: 'Mike', middleName: 'Andrew', lastName: 'Johnson' }],
]);
const clientById = new Map([['john', { _id: 'john', firstName: 'John', lastName: 'Doe', clientNumber: 'C-1' }]]);
const rateByStaffId = new Map([
  ['BCBA-TEST', { rateCents: 5000, rateType: 'HOURLY', currency: 'usd' }],
  ['RBT-TEST', { rateCents: 2500, rateType: 'HOURLY', currency: 'usd' }],
]);
const roleByStaffId = new Map([['RBT-TEST', 'RBT'], ['BCBA-TEST', 'BCBA']]);

test('projects BCBA and RBT rows with authoritative role, worked minutes and rate (spec §27)', () => {
  const sessions = [
    { _id: 'sb', appointmentId: 'ap-b', staffProfileId: 'BCBA-TEST', clientId: 'john', status: 'FROZEN', startedAt: new Date('2026-09-04T13:00:00Z'), endedAt: new Date('2026-09-04T14:30:00Z'), clockInAt: new Date('2026-09-04T13:00:00Z'), clockOutAt: new Date('2026-09-04T14:30:00Z'), selectedAuthorizationIds: ['svc:A1'] },
    { _id: 'sr', appointmentId: 'ap-r', staffProfileId: 'RBT-TEST', clientId: 'john', status: 'FROZEN', startedAt: new Date('2026-09-04T14:00:00Z'), endedAt: new Date('2026-09-04T16:00:00Z'), clockInAt: new Date('2026-09-04T14:00:00Z'), clockOutAt: new Date('2026-09-04T16:00:00Z'), selectedAuthorizationIds: ['svc:A1'] },
  ];
  // No SessionTimeRecord for either → worked minutes fall back to the verified clock.
  const rows = projectStaffActivity({ sessions, workedById: new Map(), apptById, staffById, clientById, roleByStaffId, rateByStaffId });
  const b = rows.find((r) => r.staffProfileId === 'BCBA-TEST');
  const r = rows.find((r) => r.staffProfileId === 'RBT-TEST');
  assert.equal(b.staffName, 'Sarah Jane Smith');
  assert.equal(b.role, 'BCBA');
  assert.equal(b.workedMinutes, 90);
  assert.equal(b.staffRateCents, 5000);
  assert.equal(b.clientName, 'John Doe');
  assert.equal(r.staffName, 'Mike Andrew Johnson');
  assert.equal(r.role, 'RBT');
  assert.equal(r.workedMinutes, 120);
  assert.equal(r.staffRateCents, 2500);
});

test('SessionTimeRecord.workedMinutes is authoritative when present (overrides clock)', () => {
  const sessions = [{ _id: 'sr', appointmentId: 'ap-r', staffProfileId: 'RBT-TEST', clientId: 'john', status: 'FROZEN', startedAt: new Date('2026-09-04T14:00:00Z'), endedAt: new Date('2026-09-04T16:00:00Z') }];
  const rows = projectStaffActivity({ sessions, workedById: new Map([['sr', 118]]), apptById, staffById, clientById, roleByStaffId, rateByStaffId });
  assert.equal(rows[0].workedMinutes, 118, 'time record wins over the 120-min clock');
});

test('role falls back to the care-team assignment when the appointment omits it', () => {
  // Appointment ap-x carries neither bcbaId nor rbtId (a review-frozen session).
  assert.equal(roleForSession('RBT-TEST', apptById.get('ap-x'), roleByStaffId), 'RBT');
  assert.equal(roleForSession('RBT-TEST', null, roleByStaffId), 'RBT');
  assert.equal(roleForSession('nobody', null, roleByStaffId), null);
});

test('minutesBetween returns whole minutes and 0 for incoherent pairs', () => {
  assert.equal(minutesBetween(new Date('2026-09-04T14:00:00Z'), new Date('2026-09-04T16:00:00Z')), 120);
  assert.equal(minutesBetween(new Date('2026-09-04T16:00:00Z'), new Date('2026-09-04T14:00:00Z')), 0);
  assert.equal(minutesBetween(null, new Date()), 0);
});
