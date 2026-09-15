import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BcbaSessionService } from '../src/modules/bcba-session/bcbaSession.service.js';

/**
 * In-session documentation (What / How / Client response) saved live against
 * the caller's OWN session, via the same appointment-scoped ownership guard as
 * start/stop/complete.
 *
 * ROLE NOTE. The three clinical documentation fields are the BCBA workflow; the
 * RBT's in-session input is the Session Memo, and an RBT request carrying
 * documentation fields is refused (see the RBT tests at the end of this file).
 * These cases therefore run as role=BCBA — the mechanics they cover (sparse
 * patch, clock untouched, clearing with '') are unchanged, only the role that
 * is allowed to exercise them.
 *
 * Saving:
 *   • persists each field (sealed PHI) on the session and reads back opened;
 *   • allows partial updates and clears with '';
 *   • NEVER touches clock-in/out, workedMinutes, startedAt/endedAt or status;
 *   • is refused on another clinician's appointment (ownership) and on a frozen
 *     session; and it never modifies the treatment plan.
 * DB-free, via fake ports (same pattern as bcba-session.test.js).
 */

const START = new Date('2026-09-08T17:30:00.000Z');
const sealed = (v) => (v == null ? v : `sealed(${v})`);
const opened = (v) => (typeof v === 'string' && v.startsWith('sealed(') ? v.slice(7, -1) : v);

function makeService({ role = 'BCBA', sessionStatus = 'IN_PROGRESS', ownStaff = 'bcba-1' } = {}) {
  const appt = {
    id: 'appt-1', clientId: 'child-A', bcbaId: 'bcba-1', rbtId: 'rbt-1',
    authorizationId: 'auth-ABA', authorizationIds: ['auth-ABA'],
    startAt: START, endAt: null, units: 4, status: 'SCHEDULED',
  };
  const store = {
    session: {
      id: 'sess-1', appointmentId: 'appt-1', clientId: 'child-A',
      staffProfileId: role === 'BCBA' ? 'bcba-1' : 'rbt-1',
      status: sessionStatus, startedAt: START, endedAt: null,
      clockInAt: START, clockOutAt: null, workedMinutes: null, version: 1,
      documentation: { what: null, how: null, childResponse: null },
    },
    updates: [], planUpdates: [],
  };
  const service = new BcbaSessionService({
    clock: { now: () => new Date('2026-09-08T18:30:00.000Z') },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    appointments: {
      findById: async (_t, id) => (id === appt.id ? { ...appt } : null),
      listForBcba: async () => [{ ...appt }],
      listForRbt: async () => [{ ...appt }],
    },
    sessions: {
      findByAppointment: async () => (store.session ? { ...store.session } : null),
      findById: async () => (store.session ? { ...store.session } : null),
      update: async (_t, id, patch) => {
        store.updates.push({ id, patch });
        // Apply DOTTED keys the way Mongo's $set would: documentation.* and
        // sensitive.narrative both write into their nested object rather than
        // creating a literal key with a dot in its name.
        const next = { ...store.session };
        for (const [k, v] of Object.entries(patch)) {
          if (!k.includes('.')) { next[k] = v; continue; }
          const [parent, child] = k.split('.');
          next[parent] = { ...(next[parent] ?? {}), [child]: v };
        }
        store.session = next;
        return { ...store.session };
      },
      freeze: async () => ({ ...store.session, status: 'FROZEN' }),
    },
    plans: {
      findActivePlanForClient: async () => ({ id: 'plan-A', title: 'Functional Communication', status: 'ACTIVE' }),
      // A write here would be a bug; record it so the test can assert it never happens.
      update: async (...a) => { store.planUpdates.push(a); return {}; },
    },
    clients: { findById: async (_t, id) => ({ id, firstName: 'Ada', lastName: 'B' }) },
    authorizations: { resolveMany: async (_t, ids) => ids.map((id) => ({ id, label: `Label ${id}` })) },
    payRates: { getCurrentHourlyRate: async () => 30 },
    timeRecords: { findBySession: async () => null, create: async (_t, doc) => ({ id: 'tr-1', ...doc }), list: async () => [] },
    phi: { seal: sealed, open: opened },
  });
  return { service, store };
}

const ctx = (staff = 'bcba-1') => ({ tenantId: 't1', actorUserId: 'u', bcbaStaffProfileId: staff, role: 'BCBA' });

test('BCBA saves What/How/Client response → persisted (sealed) and read back opened', async () => {
  const { service, store } = makeService();
  const res = await service.saveDocumentation({
    ...ctx(), appointmentId: 'appt-1',
    documentation: { what: 'Practiced requesting', how: 'Prompting + reinforcement', childResponse: 'Requested items independently' },
  });
  assert.equal(store.session.documentation.what, sealed('Practiced requesting'));
  assert.equal(store.session.documentation.how, sealed('Prompting + reinforcement'));
  assert.equal(store.session.documentation.childResponse, sealed('Requested items independently'));
  // Response opens them.
  assert.equal(res.documentation.what, 'Practiced requesting');
  assert.equal(res.documentation.how, 'Prompting + reinforcement');
  assert.equal(res.documentation.childResponse, 'Requested items independently');
});

test('saving documentation NEVER changes clock, worked time or status', async () => {
  const { service, store } = makeService();
  await service.saveDocumentation({ ...ctx(), appointmentId: 'appt-1', documentation: { what: 'x' } });
  const patch = store.updates.at(-1).patch;
  // Only documentation.* (+ updatedBy) may be written.
  const keys = Object.keys(patch).filter((k) => k !== 'updatedBy');
  assert.ok(keys.every((k) => k.startsWith('documentation.')), `unexpected keys: ${keys}`);
  assert.equal(store.session.status, 'IN_PROGRESS');
  assert.equal(store.session.clockInAt, START);
  assert.equal(store.session.clockOutAt, null);
  assert.equal(store.session.workedMinutes, null);
  assert.equal(store.session.startedAt, START);
});

test('partial update leaves other fields untouched; empty string clears a field', async () => {
  const { service, store } = makeService();
  await service.saveDocumentation({ ...ctx(), appointmentId: 'appt-1', documentation: { what: 'first', how: 'h' } });
  await service.saveDocumentation({ ...ctx(), appointmentId: 'appt-1', documentation: { childResponse: 'resp' } });
  assert.equal(store.session.documentation.what, sealed('first'));   // untouched
  assert.equal(store.session.documentation.childResponse, sealed('resp'));
  await service.saveDocumentation({ ...ctx(), appointmentId: 'appt-1', documentation: { what: '' } });
  assert.equal(store.session.documentation.what, null);              // cleared
  assert.equal(store.session.documentation.how, sealed('h'));        // still untouched
});

test('saving documentation never writes to the treatment plan', async () => {
  const { service, store } = makeService();
  await service.saveDocumentation({ ...ctx(), appointmentId: 'appt-1', documentation: { what: 'x', how: 'y', childResponse: 'z' } });
  assert.equal(store.planUpdates.length, 0);
});

test('an RBT cannot document an appointment that is not theirs (ownership)', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.saveDocumentation({ ...ctx('rbt-OTHER'), appointmentId: 'appt-1', documentation: { what: 'x' } }),
    (e) => e.code === 'NOT_YOUR_APPOINTMENT' || e.status === 403,
  );
});

test('documentation cannot be saved on a completed (frozen) session', async () => {
  const { service } = makeService({ sessionStatus: 'FROZEN' });
  await assert.rejects(
    () => service.saveDocumentation({ ...ctx(), appointmentId: 'appt-1', documentation: { what: 'x' } }),
    (e) => e.code === 'SESSION_ALREADY_COMPLETED',
  );
});

test('BCBA documents through the same pipeline (role=BCBA), independent of RBT', async () => {
  const { service, store } = makeService({ role: 'BCBA' });
  const res = await service.saveDocumentation({ tenantId: 't1', actorUserId: 'u', bcbaStaffProfileId: 'bcba-1', role: 'BCBA', appointmentId: 'appt-1', documentation: { what: 'bcba work' } });
  assert.equal(store.session.documentation.what, sealed('bcba work'));
  assert.equal(res.documentation.what, 'bcba work');
});

// --- the RBT workflow: memo, not clinical documentation ----------------------

test('an RBT is REFUSED the three clinical documentation fields', async () => {
  const { service, store } = makeService({ role: 'RBT', ownStaff: 'rbt-1' });
  await assert.rejects(
    () => service.saveDocumentation({
      tenantId: 't1', actorUserId: 'u', bcbaStaffProfileId: 'rbt-1', role: 'RBT',
      appointmentId: 'appt-1', documentation: { what: 'x' },
    }),
    (e) => e.code === 'DOCUMENTATION_NOT_PERMITTED',
  );
  // Refused, not partially applied.
  assert.equal(store.session.documentation?.what ?? null, null);
});

test('an RBT saves a Session Memo into the session\'s existing sealed note field', async () => {
  const { service, store } = makeService({ role: 'RBT', ownStaff: 'rbt-1' });
  const res = await service.saveDocumentation({
    tenantId: 't1', actorUserId: 'u', bcbaStaffProfileId: 'rbt-1', role: 'RBT',
    appointmentId: 'appt-1', documentation: { memo: 'Client engaged throughout.' },
  });

  // Sealed at rest, opened on read — and stored in the SAME field the
  // completion flow uses, so there is no second memo and no second notes path.
  assert.equal(store.session.sensitive.narrative, sealed('Client engaged throughout.'));
  assert.equal(res.memo, 'Client engaged throughout.');
  // The clinical documentation fields stay empty for an RBT session.
  assert.equal(res.documentation.what, null);
  assert.equal(res.documentation.how, null);
  assert.equal(res.documentation.childResponse, null);
});
