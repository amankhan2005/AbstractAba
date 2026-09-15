import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionsService } from '../src/modules/sessions/sessions.service.js';

/**
 * Session Insights detail rows (spec §10/§11). listSessions decoration must keep
 * SCHEDULED time (from each session's OWN appointment) and ACTUAL time (from that
 * session's OWN SessionTimeRecord) strictly separate, never copying one
 * clinician's window onto the other and never fabricating a time for a date-only
 * appointment.
 */
function makeService({ rows, appts, timeRecs }) {
  return new SessionsService({
    repository: { listSessions: async () => ({ items: rows, nextCursor: null }) },
    appointments: { findById: async (_t, id) => appts[id] ?? null },
    clients: { findById: async (_t, id) => (id === 'c-1' ? { id, firstName: 'John', lastName: 'Smith' } : null) },
    staff: { findById: async (_t, id) => ({ 'bcba-1': { firstName: 'Jane', lastName: 'Smith' }, 'rbt-1': { firstName: 'Mike', lastName: 'Jones' } }[id] ?? null) },
    timeRecords: { findBySession: async (_t, id) => timeRecs[id] ?? null },
    phi: { open: (v) => v },
  });
}

// BCBA appointment 5:30–6:30 PM; RBT appointment 6:00–7:00 PM. Distinct records.
const appts = {
  'ap-b': { id: 'ap-b', bcbaId: 'bcba-1', rbtId: null, startAt: '2026-09-11T17:30:00Z', endAt: '2026-09-11T18:30:00Z', timeSet: true },
  'ap-r': { id: 'ap-r', bcbaId: null, rbtId: 'rbt-1', startAt: '2026-09-11T18:00:00Z', endAt: '2026-09-11T19:00:00Z', timeSet: true },
  'ap-dateonly': { id: 'ap-dateonly', bcbaId: 'bcba-1', rbtId: null, startAt: '2026-09-12T00:00:00Z', endAt: null, timeSet: false },
};

test('scheduled from own appointment, actual from own time record — never merged', async () => {
  const rows = [
    { id: 's-b', appointmentId: 'ap-b', clientId: 'c-1', staffProfileId: 'bcba-1', status: 'FROZEN', startedAt: '2026-09-11T17:32:00Z', endedAt: '2026-09-11T18:28:00Z' },
    { id: 's-r', appointmentId: 'ap-r', clientId: 'c-1', staffProfileId: 'rbt-1', status: 'FROZEN', startedAt: '2026-09-11T18:02:00Z', endedAt: '2026-09-11T18:55:00Z' },
  ];
  const timeRecs = {
    's-b': { workedMinutes: 56, startedAt: '2026-09-11T17:32:00Z', endedAt: '2026-09-11T18:28:00Z' },
    's-r': { workedMinutes: 53, startedAt: '2026-09-11T18:02:00Z', endedAt: '2026-09-11T18:55:00Z' },
  };
  const svc = makeService({ rows, appts, timeRecs });
  const { items } = await svc.listSessions({ tenantId: 't', clientId: 'c-1' });
  const b = items.find((r) => r.id === 's-b');
  const r = items.find((r) => r.id === 's-r');

  // Scheduled comes from each session's OWN appointment.
  assert.equal(b.scheduledStart, '2026-09-11T17:30:00Z');
  assert.equal(b.scheduledEnd, '2026-09-11T18:30:00Z');
  assert.equal(r.scheduledStart, '2026-09-11T18:00:00Z');
  assert.equal(r.scheduledEnd, '2026-09-11T19:00:00Z');
  // The BCBA window is never copied onto the RBT session, or vice versa.
  assert.notEqual(b.scheduledStart, r.scheduledStart);

  // Actual worked time + clock in/out come from each session's OWN time record.
  assert.equal(b.workedMinutes, 56);
  assert.equal(r.workedMinutes, 53);
  assert.equal(b.actualStart, '2026-09-11T17:32:00Z');
  assert.equal(b.actualEnd, '2026-09-11T18:28:00Z');
  assert.equal(r.actualStart, '2026-09-11T18:02:00Z');
  assert.equal(r.actualEnd, '2026-09-11T18:55:00Z');
});

test('date-only appointment carries scheduledTimeSet:false (no fabricated clock time)', async () => {
  const rows = [{ id: 's-d', appointmentId: 'ap-dateonly', clientId: 'c-1', staffProfileId: 'bcba-1', status: 'FROZEN', startedAt: '2026-09-12T14:00:00Z' }];
  const svc = makeService({ rows, appts, timeRecs: {} });
  const { items } = await svc.listSessions({ tenantId: 't', clientId: 'c-1' });
  assert.equal(items[0].scheduledTimeSet, false);
});

test('missing time record yields null actual time, never a fabricated value', async () => {
  const rows = [{ id: 's-b', appointmentId: 'ap-b', clientId: 'c-1', staffProfileId: 'bcba-1', status: 'FROZEN', startedAt: '2026-09-11T17:32:00Z' }];
  const svc = makeService({ rows, appts, timeRecs: {} });
  const { items } = await svc.listSessions({ tenantId: 't', clientId: 'c-1' });
  assert.equal(items[0].workedMinutes, null);
  assert.equal(items[0].actualStart, null);
  assert.equal(items[0].actualEnd, null);
});
