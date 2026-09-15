import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BcbaSessionService } from '../src/modules/bcba-session/bcbaSession.service.js';

/**
 * WEEKLY TARGET BLOCK — server-side enforcement (spec §14, §15).
 *
 * These DB-free tests exercise the START path with the weekly-hours ports wired,
 * proving the rule the spec calls non-negotiable: once a BCBA has completed the
 * company's configured weekly requirement, the SERVER refuses to start another
 * session for that company week — but a BCBA who is still short of the target,
 * or who is resuming an already-live session, is never blocked.
 */

const NOW = new Date('2026-09-04T21:50:12.000Z'); // Fri 17:50 EDT

function makeService({
  staffing = { weeklyHoursTarget: 30, weekStartsOn: 0 },
  sum = { minutes: 0, sessions: 0 },
  existingSession = null,
  timezone = 'America/New_York',
} = {}) {
  const store = { created: [] };
  const appt = {
    id: 'appt-1', clientId: 'child-A', bcbaId: 'bcba-1', rbtId: 'rbt-1',
    authorizationId: 'auth-ABA', authorizationIds: ['auth-ABA'],
    startAt: NOW, endAt: new Date(NOW.getTime() + 3.6e6), status: 'SCHEDULED',
  };
  const svc = new BcbaSessionService({
    clock: { now: () => NOW },
    organizations: { getById: async () => ({ state: 'ACTIVE', timezone }) },
    settings: { getStaffing: async () => staffing },
    appointments: {
      findById: async (_t, id) => (id === appt.id ? { ...appt } : null),
      listForBcba: async () => [{ ...appt }],
    },
    sessions: {
      findByAppointment: async () => (existingSession ? { ...existingSession } : null),
      findById: async () => (existingSession ? { ...existingSession } : null),
      create: async (_t, doc) => { store.created.push(doc); return { id: 'sess-1', ...doc }; },
      update: async (_t, _id, patch) => ({ id: existingSession?.id ?? 'sess-1', ...existingSession, ...patch }),
      freeze: async () => ({ id: 'sess-1', status: 'FROZEN' }),
    },
    plans: { findActivePlanForClient: async () => null },
    timeRecords: {
      sumWorkedMinutes: async () => sum,
      findBySession: async () => null,
      create: async (_t, doc) => ({ id: 'tr-1', ...doc }),
    },
    phi: { seal: (v) => v, open: (v) => v },
  });
  return { svc, store };
}

const start = (svc) => svc.startSession({
  tenantId: 't1', actorUserId: 'u1', bcbaStaffProfileId: 'bcba-1', appointmentId: 'appt-1',
});

test('30h target, 30h already worked → START is rejected server-side (§14)', async () => {
  const { svc, store } = makeService({ sum: { minutes: 30 * 60, sessions: 30 } });
  await assert.rejects(
    () => start(svc),
    (err) => {
      assert.equal(err.code, 'WEEKLY_TARGET_REACHED');
      assert.equal(err.status, 409);
      assert.match(err.message, /Your 30-hour weekly schedule is complete/i);
      return true;
    },
  );
  assert.equal(store.created.length, 0, 'no session was created (no create-then-fix)');
});

test('30h target, over target (32h) → still rejected (§14)', async () => {
  const { svc } = makeService({ sum: { minutes: 32 * 60, sessions: 32 } });
  await assert.rejects(() => start(svc), (e) => e.code === 'WEEKLY_TARGET_REACHED');
});

test('30h target, only 29h worked → START is allowed for the valid remaining hour (§15)', async () => {
  const { svc, store } = makeService({ sum: { minutes: 29 * 60, sessions: 29 } });
  const session = await start(svc);
  assert.equal(session.status, 'IN_PROGRESS');
  assert.equal(store.created.length, 1, 'the remaining-hour session was created');
});

test('no configured target → START is never blocked, even with hours worked (§17)', async () => {
  const { svc, store } = makeService({ staffing: { weeklyHoursTarget: 0 }, sum: { minutes: 40 * 60, sessions: 40 } });
  const session = await start(svc);
  assert.equal(session.status, 'IN_PROGRESS');
  assert.equal(store.created.length, 1);
});

test('target reached but a live session already exists → RESUME is allowed, not blocked (§15)', async () => {
  const existingSession = { id: 'sess-live', status: 'IN_PROGRESS', startedAt: new Date(NOW.getTime() - 6e5), clientId: 'child-A' };
  const { svc, store } = makeService({ sum: { minutes: 30 * 60, sessions: 30 }, existingSession });
  const session = await start(svc);
  assert.equal(session.id, 'sess-live', 'resolved to the existing live session');
  assert.equal(store.created.length, 0, 'no duplicate session created');
});

test('the block reuses the same company-week truth (target/completed surfaced in the error)', async () => {
  const { svc } = makeService({ sum: { minutes: 30 * 60, sessions: 30 } });
  await assert.rejects(() => start(svc), (err) => {
    assert.equal(err.details?.targetText, '30h 00m');
    assert.equal(err.details?.completedText, '30h 00m');
    assert.equal(err.details?.remainingText, '0h 00m');
    return true;
  });
});
