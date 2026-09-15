import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BcbaSessionService } from '../src/modules/bcba-session/bcbaSession.service.js';

/**
 * Spec §22–§25 — at completion a clinician (BCBA or RBT) may select MULTIPLE
 * eligible authorizations, and EACH selected authorization carries its OWN memo
 * (never collapsed into one generic note). This is additive: the legacy single
 * { authorizationId, memo } form still works. Every selected id is validated
 * server-side against the appointment's eligible set; a wrong/foreign id is
 * rejected. The per-session time record records the SELECTED set. DB-free, via
 * fake ports (same pattern as bcba-session.test.js).
 */

const FIXED_NOW = new Date('2026-09-08T18:30:00.000Z');
const START = new Date('2026-09-08T17:30:00.000Z');
const sealed = (v) => (v == null ? v : `sealed(${v})`);
const opened = (v) => (typeof v === 'string' && v.startsWith('sealed(') ? v.slice(7, -1) : v);

function makeService({ role = 'BCBA' } = {}) {
  const appt = {
    id: 'appt-1', clientId: 'child-A', bcbaId: 'bcba-1', rbtId: 'rbt-1',
    authorizationId: 'auth-ABA', authorizationIds: ['auth-ABA', 'auth-FBA', 'auth-3'],
    startAt: START, endAt: FIXED_NOW, units: 4, status: 'SCHEDULED',
  };
  const store = {
    session: { id: 'sess-1', appointmentId: 'appt-1', clientId: 'child-A', staffProfileId: role === 'RBT' ? 'rbt-1' : 'bcba-1', status: 'IN_PROGRESS', startedAt: START, endedAt: null, version: 1 },
    timeRecords: [], updates: [], freezes: [],
  };
  const service = new BcbaSessionService({
    clock: { now: () => FIXED_NOW },
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
        store.session = { ...store.session, ...patch };
        if (patch['sensitive.narrative'] !== undefined) store.session.sensitive = { narrative: patch['sensitive.narrative'] };
        return { ...store.session };
      },
      freeze: async (_t, id, actor) => { store.freezes.push({ id, actor }); store.session = { ...store.session, status: 'FROZEN', frozenBy: actor }; return { ...store.session }; },
    },
    plans: { findActivePlanForClient: async () => ({ id: 'plan-A' }) },
    clients: { findById: async (_t, id) => ({ id, firstName: 'Ada', lastName: 'B' }) },
    authorizations: {
      resolveMany: async (_t, ids) => ids.map((id) => ({ id, label: `Label ${id}`, authorizationNumber: id, serviceCode: 'ABA', status: 'ACTIVE' })),
    },
    payRates: { getCurrentHourlyRate: async () => 30 },
    timeRecords: {
      findBySession: async (_t, sid) => store.timeRecords.find((r) => r.sessionId === sid) ?? null,
      create: async (_t, doc) => {
        const dup = store.timeRecords.find((r) => r.sessionId === doc.sessionId);
        if (dup) return { ...dup };
        const rec = { id: `tr-${store.timeRecords.length + 1}`, ...doc };
        store.timeRecords.push(rec); return { ...rec };
      },
      list: async () => store.timeRecords.map((r) => ({ ...r })),
    },
    phi: { seal: sealed, open: opened },
  });
  return { service, store, appt };
}

const ctx = { tenantId: 't1', actorUserId: 'u', bcbaStaffProfileId: 'bcba-1' };

test('BCBA completes with MULTIPLE authorizations, each with its own memo', async () => {
  const { service, store } = makeService();
  const res = await service.completeSession({
    ...ctx,
    appointmentId: 'appt-1',
    authorizations: [
      { authorizationId: 'auth-ABA', memo: 'ABA memo' },
      { authorizationId: 'auth-FBA', memo: 'FBA memo' },
      { authorizationId: 'auth-3', memo: 'third memo' },
    ],
  });
  // Session persisted the full selected set + primary.
  assert.deepEqual(store.session.selectedAuthorizationIds, ['auth-ABA', 'auth-FBA', 'auth-3']);
  assert.equal(store.session.selectedAuthorizationId, 'auth-ABA');
  // Each authorization kept its OWN sealed memo — not collapsed.
  assert.equal(store.session.authorizationMemos.length, 3);
  assert.equal(store.session.authorizationMemos[1].authorizationId, 'auth-FBA');
  assert.equal(store.session.authorizationMemos[1].memo, sealed('FBA memo'));
  // Response opens the memos back to plaintext (authorised read).
  const byId = Object.fromEntries(res.session.authorizationMemos.map((m) => [m.authorizationId, m.memo]));
  assert.equal(byId['auth-ABA'], 'ABA memo');
  assert.equal(byId['auth-3'], 'third memo');
  // The full selected set is returned for the completion screen.
  assert.deepEqual(res.authorizations.map((a) => a.id), ['auth-ABA', 'auth-FBA', 'auth-3']);
  // The per-session time record records the SELECTED set (spec §22).
  assert.deepEqual(store.timeRecords[0].authorizationIds, ['auth-ABA', 'auth-FBA', 'auth-3']);
  assert.equal(store.timeRecords[0].authorizationId, 'auth-ABA');
});

test('a selected authorization NOT bound to the appointment is rejected (INVALID_AUTHORIZATION), nothing persisted', async () => {
  const { service, store } = makeService();
  await assert.rejects(
    () => service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizations: [{ authorizationId: 'auth-ABA', memo: 'ok' }, { authorizationId: 'auth-FOREIGN', memo: 'x' }] }),
    (e) => e.code === 'INVALID_AUTHORIZATION',
  );
  assert.equal(store.freezes.length, 0);
  assert.equal(store.timeRecords.length, 0);
});

test('legacy single { authorizationId, memo } form still completes and is mirrored into the multi fields', async () => {
  const { service, store } = makeService();
  const res = await service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizationId: 'auth-ABA', memo: 'just one' });
  assert.equal(store.session.selectedAuthorizationId, 'auth-ABA');
  assert.deepEqual(store.session.selectedAuthorizationIds, ['auth-ABA']);
  assert.equal(res.session.narrative, 'just one'); // legacy narrative preserved
  assert.equal(store.timeRecords.length, 1);
});

test('RBT completes with multiple authorizations through the same pipeline (role=RBT)', async () => {
  const { service, store } = makeService({ role: 'RBT' });
  const rbtCtx = { tenantId: 't1', actorUserId: 'u', bcbaStaffProfileId: 'rbt-1' };
  const res = await service.completeSession({
    ...rbtCtx, appointmentId: 'appt-1', role: 'RBT',
    authorizations: [{ authorizationId: 'auth-ABA', memo: 'a' }, { authorizationId: 'auth-FBA', memo: 'b' }],
  });
  assert.deepEqual(store.session.selectedAuthorizationIds, ['auth-ABA', 'auth-FBA']);
  assert.equal(res.authorizations.length, 2);
  assert.equal(store.timeRecords[0].staffProfileId, 'rbt-1');
});

test('duplicate authorization ids collapse to one (first memo wins), order preserved', async () => {
  const { service, store } = makeService();
  await service.completeSession({
    ...ctx, appointmentId: 'appt-1',
    authorizations: [{ authorizationId: 'auth-ABA', memo: 'first' }, { authorizationId: 'auth-ABA', memo: 'second' }],
  });
  assert.deepEqual(store.session.selectedAuthorizationIds, ['auth-ABA']);
  assert.equal(store.session.authorizationMemos.length, 1);
  assert.equal(store.session.authorizationMemos[0].memo, sealed('first'));
});
