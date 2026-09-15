import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { trendBuckets, aggregateOversightInsights } from '../src/modules/sessions/sessions.oversight.js';

/**
 * SESSION INSIGHTS — GET /v1/sessions/oversight/insights.
 *
 * Pure aggregation (trend buckets, totals, role attribution, recent rows) and
 * the real-MongoDB service path: authoritative SessionTimeRecord minutes,
 * org-calendar date filters, client/clinician/status filters, tenant isolation,
 * the caller's data scope, and the sessions.read guard.
 */

// ---------------------------------------------------------------- pure ----
test('trendBuckets: daily ≤ 45 days, Monday weeks ≤ 180 days, months beyond — every bucket present', () => {
  const d = trendBuckets('2026-08-16', '2026-09-14');
  assert.equal(d.unit, 'day');
  assert.equal(d.keys.length, 30);
  assert.equal(d.keys[0], '2026-08-16');
  assert.equal(d.keys.at(-1), '2026-09-14');
  const w = trendBuckets('2026-06-17', '2026-09-14');
  assert.equal(w.unit, 'week');
  assert.equal(w.keys[0], '2026-06-15'); // Monday on/before Jun 17
  assert.ok(w.keys.every((k) => new Date(`${k}T00:00:00Z`).getUTCDay() === 1));
  const m = trendBuckets('2025-01-10', '2026-09-14');
  assert.equal(m.unit, 'month');
  assert.equal(m.keys.length, 21);
  assert.deepEqual(trendBuckets(null, null), { unit: 'day', keys: [] });
  assert.deepEqual(trendBuckets('2026-09-10', '2026-09-01'), { unit: 'day', keys: [] });
});

test('aggregateOversightInsights: totals from time records, role from the session’s own appointment, org-calendar dates', () => {
  const tz = 'America/New_York';
  const out = aggregateOversightInsights({
    sessions: [
      { _id: 's1', clientId: 'c1', staffProfileId: 'b1', appointmentId: 'a1', startedAt: new Date('2026-09-10T14:00:00Z'), status: 'FROZEN', source: 'APPOINTMENT' },
      { _id: 's2', clientId: 'c1', staffProfileId: 'r1', appointmentId: 'a1', startedAt: new Date('2026-09-11T02:30:00Z'), status: 'IN_PROGRESS', source: 'APPOINTMENT' }, // Sep 10 in New York
      { _id: 's3', clientId: 'c2', staffProfileId: 'r1', appointmentId: 'a2', startedAt: new Date('2026-09-12T15:00:00Z'), status: 'AMENDED', source: 'MANUAL' },
    ],
    timeRecs: [
      { sessionId: 's1', workedMinutes: 90, startedAt: new Date('2026-09-10T14:05:00Z'), endedAt: new Date('2026-09-10T15:35:00Z') },
      { sessionId: 's3', workedMinutes: 45.4, startedAt: new Date('2026-09-12T15:00:00Z'), endedAt: new Date('2026-09-12T15:45:00Z') },
    ],
    appts: [{ _id: 'a1', bcbaId: 'b1', rbtId: 'r1' }, { _id: 'a2', bcbaId: null, rbtId: 'r1' }],
    staff: [{ _id: 'b1', firstName: 'Ada', lastName: 'Lovelace' }, { _id: 'r1', firstName: 'Nia', lastName: 'Patel' }],
    clients: [{ _id: 'c1', firstName: 'Mia', lastName: 'Khan' }, { _id: 'c2', firstName: 'Sam', lastName: 'Ray', preferredName: 'Sammy' }],
    timeZone: tz, fromKey: '2026-09-09', toKey: '2026-09-12', todayKey: '2026-09-14',
  });
  assert.deepEqual(out.totals, { sessions: 3, completed: 2, inProgress: 1, workedMinutes: 135, bcbaSessions: 1, rbtSessions: 2 });
  assert.deepEqual(out.statusCounts, { FROZEN: 1, IN_PROGRESS: 1, AMENDED: 1 });
  assert.deepEqual(out.range, { from: '2026-09-09', to: '2026-09-12' });
  assert.equal(out.trend.unit, 'day');
  assert.deepEqual(out.trend.points.map((p) => [p.key, p.sessions, p.workedMinutes]), [
    ['2026-09-09', 0, 0], ['2026-09-10', 2, 90], ['2026-09-11', 0, 0], ['2026-09-12', 1, 45],
  ]);
  assert.deepEqual(out.clinicians.map((c) => [c.name, c.role, c.sessions, c.completed, c.inProgress, c.workedMinutes]), [
    ['Nia Patel', 'RBT', 2, 1, 1, 45], ['Ada Lovelace', 'BCBA', 1, 1, 0, 90],
  ]);
  assert.deepEqual(out.recent.map((r) => r.id), ['s3', 's2', 's1']);
  const live = out.recent.find((r) => r.id === 's2');
  assert.equal(live.workedMinutes, null, 'no time record → no invented minutes');
  assert.equal(live.clockOut, null);
  assert.equal(out.recent[0].childName, 'Sammy');
  assert.equal(out.recent.at(-1).clockIn.toISOString(), '2026-09-10T14:05:00.000Z', 'clock-in from the time record');
  assert.equal(out.children.length, 2);
});

test('aggregateOversightInsights: no sessions → zeros, empty lists, no placeholder data', () => {
  const out = aggregateOversightInsights({ timeZone: 'UTC', fromKey: '2026-09-01', toKey: '2026-09-03', todayKey: '2026-09-14' });
  assert.deepEqual(out.totals, { sessions: 0, completed: 0, inProgress: 0, workedMinutes: 0, bcbaSessions: 0, rbtSessions: 0 });
  assert.deepEqual(out.trend.points.map((p) => p.sessions), [0, 0, 0]);
  assert.deepEqual([out.clinicians, out.recent, out.children], [[], [], []]);
});

// ------------------------------------------------------------- real DB ----
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';
const TZ = 'America/New_York';
const ORG_SCOPE = { scope: 'ORGANIZATION', staffProfileId: null, clientIds: null, staffIds: null };

let server; let mongoose; let M; let withTenant; let sessionsService; let bcbaSessionService; let clientsService; let createSessionsRouter;
const W = {};

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  ({ sessionsService } = await import('../src/modules/sessions/index.js'));
  ({ bcbaSessionService } = await import('../src/modules/bcba-session/index.js'));
  ({ clientsService } = await import('../src/modules/clients/index.js'));
  ({ createSessionsRouter } = await import('../src/modules/sessions/sessions.routes.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));

  const org = (slug) => M.Organization.create({ slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: TZ, primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` });
  W.T = (await org('sess-ins-a'))._id;
  W.T2 = (await org('sess-ins-b'))._id;
  const seed = async (tenant, prefix, clientNames) => withTenant(tenant, async () => {
    const bcba = await M.StaffProfile.create({ userId: randomUUID(), firstName: `${prefix}Ada`, lastName: 'Lovelace', status: 'ACTIVE' });
    const rbt = await M.StaffProfile.create({ userId: randomUUID(), firstName: `${prefix}Nia`, lastName: 'Patel', status: 'ACTIVE' });
    const clients = [];
    for (const [i, first] of clientNames.entries()) {
      const c = await M.Client.create({ clientNumber: `${prefix}C-${i}`, firstName: first, lastName: 'Khan', status: 'ACTIVE' });
      await M.Guardian.create({ clientId: c._id, firstName: 'P', lastName: 'Khan', phone: '5551234567', email: `${prefix}${first}@example.com`, relationship: 'PARENT', isPrimary: true });
      await M.ClientAssignment.create({ clientId: c._id, staffProfileId: bcba._id, role: 'BCBA', status: 'ACTIVE' });
      await M.ClientAssignment.create({ clientId: c._id, staffProfileId: rbt._id, role: 'RBT', status: 'ACTIVE' });
      clients.push(c._id);
    }
    return { bcba: bcba._id, rbt: rbt._id, clients };
  });
  W.a = await seed(W.T, '', ['Mia', 'Sam']);
  W.b = await seed(W.T2, 'X', ['Leak']);
  const auths = new Map();
  const manual = async (tenant, ids, clientIdx, role, date, start, end) => {
    const clientId = ids.clients[clientIdx];
    if (!auths.has(clientId)) {
      auths.set(clientId, await clientsService.createServiceAuthorization({ tenantId: tenant, clientId, actorUserId: randomUUID(),
        input: { serviceType: 'ABA', units: 800, unitPrice: 1800, billingCode: '97153', startDate: '2026-08-01T00:00:00.000Z', endDate: '2026-12-31T00:00:00.000Z' } }));
    }
    return bcbaSessionService.createManualSession({ tenantId: tenant, actorUserId: randomUUID(), bcbaStaffProfileId: role === 'BCBA' ? ids.bcba : ids.rbt, role,
      input: { clientId, date, startTime: start, endTime: end, memo: 'Worked on requesting.', authorizationIds: [`svc:${auths.get(clientId).id}`] } });
  };
  // Tenant A: Mia — BCBA 09:00–10:30 (90) + RBT 11:00–13:00 (120) on Sep 2; Sam — RBT 09:00–09:45 (45) on Sep 9;
  // Mia — BCBA 22:00–23:00 (60) on Sep 10 (after UTC midnight, still Sep 10 in New York).
  await manual(W.T, W.a, 0, 'BCBA', '2026-09-02', '09:00', '10:30');
  await manual(W.T, W.a, 0, 'RBT', '2026-09-02', '11:00', '13:00');
  await manual(W.T, W.a, 1, 'RBT', '2026-09-09', '09:00', '09:45');
  await manual(W.T, W.a, 0, 'BCBA', '2026-09-10', '22:00', '23:00');
  await manual(W.T2, W.b, 0, 'BCBA', '2026-09-03', '10:00', '11:00');
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const insights = (args) => sessionsService.oversightInsights({ tenantId: W.T, dataScope: ORG_SCOPE, now: new Date('2026-09-14T16:00:00Z'), ...args });

test('real DB: totals, roles and worked minutes equal the persisted SessionTimeRecords', { skip }, async () => {
  const out = await insights({ from: '2026-09-01', to: '2026-09-14' });
  const recs = await withTenant(W.T, async () => await M.SessionTimeRecord.find({}).lean());
  assert.equal(out.timeZone, TZ);
  assert.equal(out.totals.sessions, 4);
  assert.equal(out.totals.workedMinutes, recs.reduce((a, r) => a + r.workedMinutes, 0));
  assert.equal(out.totals.workedMinutes, 315);
  assert.equal(out.totals.bcbaSessions, 2);
  assert.equal(out.totals.rbtSessions, 2);
  assert.equal(out.totals.completed + out.totals.inProgress <= out.totals.sessions, true);
  const statusSum = Object.values(out.statusCounts).reduce((a, n) => a + n, 0);
  assert.equal(statusSum, 4);
  assert.equal(out.trend.unit, 'day');
  assert.equal(out.trend.points.length, 14);
  const day = (k) => out.trend.points.find((p) => p.key === k);
  assert.deepEqual([day('2026-09-02').sessions, day('2026-09-02').workedMinutes], [2, 210]);
  assert.deepEqual([day('2026-09-10').sessions, day('2026-09-11').sessions], [1, 0], 'late-evening session stays on its org business date');
  const ada = out.clinicians.find((c) => c.name === 'Ada Lovelace');
  assert.deepEqual([ada.role, ada.sessions, ada.workedMinutes], ['BCBA', 2, 150]);
  assert.equal(out.recent[0].childName, 'Mia Khan');
  assert.equal(out.recent[0].workedMinutes, 60);
  assert.deepEqual(out.children.map((c) => [c.childName, c.sessionCount, c.workedMinutes]), [['Mia Khan', 3, 270], ['Sam Khan', 1, 45]]);
});

test('real DB: date window is inclusive org business dates; client, clinician and status filters are applied by the server', { skip }, async () => {
  assert.equal((await insights({ from: '2026-09-09', to: '2026-09-10' })).totals.sessions, 2);
  assert.equal((await insights({ from: '2026-09-10', to: '2026-09-10' })).totals.sessions, 1);
  assert.equal((await insights({ from: '2026-09-11' })).totals.sessions, 0);
  assert.equal((await insights({ clientId: W.a.clients[1] })).totals.sessions, 1);
  const rbtOnly = await insights({ staffProfileId: W.a.rbt });
  assert.deepEqual([rbtOnly.totals.sessions, rbtOnly.totals.rbtSessions, rbtOnly.totals.bcbaSessions], [2, 2, 0]);
  const any = await insights({});
  const someStatus = Object.keys(any.statusCounts)[0];
  assert.equal((await insights({ status: someStatus })).totals.sessions, any.statusCounts[someStatus]);
  assert.equal((await insights({ status: 'CANCELLED' })).totals.sessions, any.statusCounts.CANCELLED ?? 0);
});

test('real DB: tenant isolation and the clinician data scope', { skip }, async () => {
  const a = await insights({});
  assert.ok(!a.recent.some((r) => r.childName === 'Leak Khan'));
  assert.ok(!a.clinicians.some((c) => /^X/.test(c.name)));
  const b = await sessionsService.oversightInsights({ tenantId: W.T2, dataScope: ORG_SCOPE });
  assert.equal(b.totals.sessions, 1);
  assert.equal(b.recent[0].childName, 'Leak Khan');
  // A foreign client id cannot pull another tenant's data.
  assert.equal((await insights({ clientId: W.b.clients[0] })).totals.sessions, 0);
  const rbtScope = { scope: 'SELF', staffProfileId: W.a.rbt, clientIds: [], staffIds: [W.a.rbt] };
  const scoped = await sessionsService.oversightInsights({ tenantId: W.T, dataScope: rbtScope });
  assert.ok(scoped.totals.sessions <= a.totals.sessions);
  assert.ok(scoped.recent.every((r) => r.clinicianName === 'Nia Patel'));
});

test('RBAC + validation: insights require sessions.read and a strict query', { skip }, async () => {
  const router = createSessionsRouter({});
  const layer = router.stack.find((l) => l.route?.path === '/oversight/insights' && l.route.methods.get);
  assert.ok(layer, 'route registered');
  let error;
  await layer.route.stack[0].handle({ principal: { permissions: new Set() } }, {}, (e) => { error = e; });
  assert.match(error?.message ?? '', /Missing permission: sessions\.read/);
  const { sessionInsightsQuerySchema } = await import('../src/modules/sessions/sessions.schemas.js');
  assert.equal(sessionInsightsQuerySchema.safeParse({ from: '2026-09-01', to: '2026-09-14' }).success, true);
  assert.equal(sessionInsightsQuerySchema.safeParse({ from: '2026-09-14', to: '2026-09-01' }).success, false);
  assert.equal(sessionInsightsQuerySchema.safeParse({ tenantId: randomUUID() }).success, false, 'tenant never accepted from the browser');
  assert.equal(sessionInsightsQuerySchema.safeParse({ from: '09/01/2026' }).success, false);
});
