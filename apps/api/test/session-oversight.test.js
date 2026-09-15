import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateOversightChildren } from '../src/modules/sessions/sessions.oversight.js';

/**
 * Session Oversight child list (spec §4/§6/§9/§10). Per child: the BCBA(s) and
 * RBT(s) who actually worked (from each session's own appointment assignment,
 * never merged), session count, total worked minutes (authoritative
 * SessionTimeRecord), and last session. DB-free.
 */
const apptById = new Map([
  ['ap-b', { _id: 'ap-b', bcbaId: 'bcba-1', rbtId: null }],
  ['ap-r', { _id: 'ap-r', bcbaId: null, rbtId: 'rbt-1' }],
  ['ap-r2', { _id: 'ap-r2', bcbaId: null, rbtId: 'rbt-2' }],
]);
const staffById = new Map([
  ['bcba-1', { _id: 'bcba-1', firstName: 'Sarah', lastName: 'Wilson' }],
  ['rbt-1', { _id: 'rbt-1', firstName: 'Mike', lastName: 'Jones' }],
  ['rbt-2', { _id: 'rbt-2', firstName: 'Dana', lastName: 'Lee' }],
]);
const clientById = new Map([
  ['c-1', { _id: 'c-1', firstName: 'John', lastName: 'Smith' }],
  ['c-2', { _id: 'c-2', firstName: 'Amy', lastName: 'Ray', clientNumber: 'CL-2' }],
]);

const sessions = [
  { _id: 's1', clientId: 'c-1', staffProfileId: 'bcba-1', appointmentId: 'ap-b', startedAt: new Date('2026-09-08T10:00:00Z') },
  { _id: 's2', clientId: 'c-1', staffProfileId: 'rbt-1', appointmentId: 'ap-r', startedAt: new Date('2026-09-09T10:00:00Z') },
  { _id: 's3', clientId: 'c-1', staffProfileId: 'rbt-2', appointmentId: 'ap-r2', startedAt: new Date('2026-09-07T10:00:00Z') },
  { _id: 's4', clientId: 'c-2', staffProfileId: 'rbt-1', appointmentId: 'ap-r', startedAt: new Date('2026-09-05T10:00:00Z') },
];
const workedBySession = new Map([['s1', 75], ['s2', 120], ['s3', 60], ['s4', 30]]);

test('rolls up BCBA/RBT names, session count, worked minutes and last session per child', () => {
  const rows = aggregateOversightChildren({ sessions, workedBySession, apptById, staffById, clientById });
  const john = rows.find((r) => r.clientId === 'c-1');
  assert.equal(john.childName, 'John Smith');           // friendly name, not UUID
  assert.deepEqual(john.bcbaNames, ['Sarah Wilson']);
  assert.deepEqual(john.rbtNames, ['Dana Lee', 'Mike Jones']); // both RBTs, sorted, not merged with BCBA
  assert.equal(john.sessionCount, 3);
  assert.equal(john.workedMinutes, 255);                // 75+120+60 (authoritative)
  assert.equal(john.lastSessionAt, new Date('2026-09-09T10:00:00Z').toISOString());
});

test('a child with only an RBT shows no BCBA (no invented assignment)', () => {
  const rows = aggregateOversightChildren({ sessions, workedBySession, apptById, staffById, clientById });
  const amy = rows.find((r) => r.clientId === 'c-2');
  assert.deepEqual(amy.bcbaNames, []);
  assert.deepEqual(amy.rbtNames, ['Mike Jones']);
  assert.equal(amy.sessionCount, 1);
  assert.equal(amy.workedMinutes, 30);
});

test('rows are sorted by child name and contain no raw ids beyond clientId key', () => {
  const rows = aggregateOversightChildren({ sessions, workedBySession, apptById, staffById, clientById });
  assert.deepEqual(rows.map((r) => r.childName), ['Amy Ray', 'John Smith']);
  for (const r of rows) {
    assert.ok(!r.staffProfileId && !r.appointmentId, 'no staff/appointment ids leak into the row');
  }
});

test('missing time record contributes 0 minutes, never a fabricated value', () => {
  const rows = aggregateOversightChildren({ sessions: [{ _id: 'x', clientId: 'c-1', staffProfileId: 'rbt-1', appointmentId: 'ap-r', startedAt: new Date('2026-09-01T10:00:00Z') }], workedBySession: new Map(), apptById, staffById, clientById });
  assert.equal(rows[0].workedMinutes, 0);
  assert.equal(rows[0].sessionCount, 1);
});
