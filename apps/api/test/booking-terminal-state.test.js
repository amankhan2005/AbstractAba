import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service.js';

/**
 * ---------------------------------------------------------------------------
 * P0 — "Book appointment" must never spin forever.
 *
 * The rebuilt pipeline is deterministic: the create path is a single insert
 * with no multi-document transaction, no availability/overlap query, no
 * external call. The service therefore always reaches a TERMINAL state — it
 * RESOLVES on a successful write and REJECTS on a failing write, so the
 * controller/asyncHandler always sends a response and the spinner always clears.
 *
 * Source-level regressions from earlier spinner work are kept as guards:
 *   • the remaining transactional writes (reschedule/cancel/series) stay
 *     time-bounded (maxCommitTimeMS + a majority wtimeout);
 *   • the DB connection bounds individual operations (socketTimeoutMS);
 *   • scheduling still surfaces a child's ABA/FBA authorizations in every state.
 * ---------------------------------------------------------------------------
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = 'child-1';
const BCBA = 'bcba-1';
const RBT = 'rbt-1';
const AUTH_ID = 'svc:auth-1';

function baseDeps(createAppointmentSimple) {
  const auth = {
    id: AUTH_ID, clientId: CLIENT, serviceCode: 'ABA', status: 'ACTIVE',
    startDate: '2026-01-01', endDate: '2026-12-31', authorizedUnits: 160, usedUnits: 0, remainingUnits: 160,
  };
  return {
    // Pinned server clock: new appointments must be today…end of this month.
    clock: { now: () => new Date('2026-09-01T12:00:00Z') },
    repository: {
      findAuthorizationById: async () => ({ ...auth }),
      createAppointmentSimple,
      findAppointmentById: async () => null,
    },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    clients: { findById: async () => ({ id: CLIENT, status: 'ACTIVE' }) },
    assignments: {
      listActiveForClient: async () => [
        { staffProfileId: BCBA, role: 'BCBA', status: 'ACTIVE' },
        { staffProfileId: RBT, role: 'RBT', status: 'ACTIVE' },
      ],
    },
  };
}

// One clinician per appointment (spec §4) — RBT-only here.
const input = {
  clientId: CLIENT, rbtId: RBT, authorizationIds: [AUTH_ID],
  startDate: '2026-09-09', endDate: '2026-09-09', startTime: '15:00', units: 4,
};

test('a successful write makes bookAppointment RESOLVE (terminal)', async () => {
  const service = new SchedulingService(baseDeps(async (_t, doc) => ({ id: 'appt-1', ...doc })));
  const appt = await service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input });
  assert.equal(appt.id, 'appt-1');
});

test('a stalled/failed write makes bookAppointment REJECT — it never hangs pending', async () => {
  const boom = Object.assign(new Error('MaxTimeMSExpired'), { code: 50 });
  const service = new SchedulingService(baseDeps(async () => { throw boom; }));
  await assert.rejects(
    () => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input }),
    /MaxTimeMSExpired/,
  );
});

test('the new create path uses NO multi-document transaction (no _maybeTx / withTransaction)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = readFileSync(resolve(here, '../src/modules/scheduling/scheduling.repository.js'), 'utf8');
  // Isolate createAppointmentSimple's body and assert it neither opens a session
  // nor runs a transaction — the deterministic single-insert guarantee.
  const start = repo.indexOf('async createAppointmentSimple(');
  assert.ok(start >= 0, 'createAppointmentSimple exists');
  const body = repo.slice(start, repo.indexOf('async findAppointmentById(', start));
  assert.doesNotMatch(body, /_maybeTx|withTransaction|startSession/);
  assert.match(body, /Appointment\.create/);
});

test('remaining transactional writes stay time-bounded (no unbounded commit)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = readFileSync(resolve(here, '../src/modules/scheduling/scheduling.repository.js'), 'utf8');
  assert.match(repo, /maxCommitTimeMS/);
  assert.match(repo, /wtimeout/);
});

test('the DB connection bounds individual operations (socketTimeoutMS)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const db = readFileSync(resolve(here, '../src/config/db.js'), 'utf8');
  assert.match(db, /socketTimeoutMS/);
});

test('scheduling surfaces the child\u2019s ABA/FBA authorizations in every state (no APPROVED-only filter)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = readFileSync(resolve(here, '../src/modules/scheduling/scheduling.repository.js'), 'utf8');
  assert.doesNotMatch(repo, /clientId: query\.clientId, deletedAt: null, status: 'APPROVED'/);
  assert.match(repo, /const svcFilter = \{ clientId: query\.clientId, deletedAt: null \};/);
});
