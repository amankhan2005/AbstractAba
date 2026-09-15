import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * SESSIONS LIST + DETAIL — performance and correctness against a REAL MongoDB.
 *
 * Root cause of the slow Company Sessions page: GET /v1/sessions decorated each
 * row with sequential awaits (appointment, time record, names) — 57 database
 * commands for 25 rows, i.e. 57 network round trips on a remote database.
 * The decoration now issues ONE batched read per related collection.
 *
 * Pinned here:
 *   • a page of 30 sessions costs a small constant number of commands;
 *   • every row still carries the same authoritative data (names, role,
 *     SessionTimeRecord clock-in/out and worked minutes, scheduled window);
 *   • detail composes the same context (plus the treatment plan's name);
 *   • tenant isolation and the clinician data scope are unchanged.
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';
const TZ = 'America/New_York';

let server; let mongoose; let M; let withTenant; let sessionsService; let bcbaSessionService; let clientsService; let createSessionsRouter;
const W = {};
const commands = [];

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri(), { monitorCommands: true });
  mongoose.connection.getClient().on('commandStarted', (e) => { if (['find', 'aggregate'].includes(e.commandName)) commands.push(String(e.command[e.commandName])); });
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  ({ sessionsService } = await import('../src/modules/sessions/index.js'));
  ({ bcbaSessionService } = await import('../src/modules/bcba-session/index.js'));
  ({ clientsService } = await import('../src/modules/clients/index.js'));
  ({ createSessionsRouter } = await import('../src/modules/sessions/sessions.routes.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));

  const org = (slug) => M.Organization.create({ slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: TZ, primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` });
  W.T = (await org('sess-perf-a'))._id;
  W.T2 = (await org('sess-perf-b'))._id;
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
  W.a = await seed(W.T, '', ['Mia', 'Sam', 'Eve']);
  W.b = await seed(W.T2, 'X', ['Leak']);
  W.plan = await withTenant(W.T, async () => (await M.TreatmentPlan.create({ clientId: W.a.clients[0], title: 'Functional Communication Plan', responsibleBcbaStaffId: W.a.bcba, status: 'ACTIVE' }))._id);

  const manual = async (tenant, ids, clientIdx, role, day, start, end) => {
    const clientId = ids.clients[clientIdx];
    const auth = W.auths?.get(clientId) ?? await clientsService.createServiceAuthorization({ tenantId: tenant, clientId, actorUserId: randomUUID(),
      input: { serviceType: 'ABA', units: 800, unitPrice: 1800, billingCode: '97153', startDate: '2026-08-01T00:00:00.000Z', endDate: '2026-12-31T00:00:00.000Z' } });
    (W.auths ??= new Map()).set(clientId, auth);
    return bcbaSessionService.createManualSession({ tenantId: tenant, actorUserId: randomUUID(), bcbaStaffProfileId: role === 'BCBA' ? ids.bcba : ids.rbt, role,
      input: { clientId, date: `2026-09-${String(day).padStart(2, '0')}`, startTime: start, endTime: end, memo: 'Worked on requesting.', authorizationIds: [`svc:${auth.id}`] } });
  };
  // 30 sessions in tenant A: 3 clients × 5 days × (BCBA + RBT), staggered so no clinician overlaps itself.
  for (const [ci] of W.a.clients.entries()) {
    for (let d = 1; d <= 5; d += 1) {
      await manual(W.T, W.a, ci, 'BCBA', d, `${String(8 + ci * 2).padStart(2, '0')}:00`, `${String(9 + ci * 2).padStart(2, '0')}:30`);
      await manual(W.T, W.a, ci, 'RBT', d, `${String(13 + ci * 2).padStart(2, '0')}:15`, `${String(14 + ci * 2).padStart(2, '0')}:00`);
    }
  }
  await manual(W.T2, W.b, 0, 'BCBA', 3, '10:00', '11:00');
  if (W.plan) {
    W.planSession = (await withTenant(W.T, async () => await M.Session.findOne({ clientId: W.a.clients[0] }).lean()))._id;
    await withTenant(W.T, async () => await M.Session.updateOne({ _id: W.planSession }, { $set: { treatmentPlanId: W.plan } }));
  }
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const ORG_SCOPE = { scope: 'ORGANIZATION', staffProfileId: null, clientIds: null, staffIds: null };

test('the list page costs a constant number of database commands (batched), not several per row', { skip }, async () => {
  commands.length = 0;
  const page = await sessionsService.listSessions({ tenantId: W.T, limit: 50, dataScope: ORG_SCOPE });
  assert.equal(page.items.length, 30);
  const byCollection = commands.reduce((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {});
  assert.ok(commands.length <= 6, `expected ≤ 6 commands, got ${commands.length}: ${JSON.stringify(byCollection)}`);
  for (const coll of ['appointment', 'session_time_record', 'client', 'staffProfile']) {
    assert.ok((byCollection[coll] ?? 0) <= 1, `${coll} read ${byCollection[coll]} times`);
  }
  assert.equal(byCollection.user ?? 0, 0, 'no per-staff user/email lookup for a name');
});

test('every row still carries the authoritative data: names, role, SessionTimeRecord times and worked minutes', { skip }, async () => {
  const { items } = await sessionsService.listSessions({ tenantId: W.T, limit: 50, dataScope: ORG_SCOPE });
  const records = await withTenant(W.T, async () => await M.SessionTimeRecord.find({}).lean());
  const recBySession = new Map(records.map((r) => [r.sessionId, r]));
  for (const row of items) {
    const rec = recBySession.get(row.id);
    assert.ok(rec, 'each manual session has its time record');
    assert.equal(row.workedMinutes, rec.workedMinutes);
    assert.equal(new Date(row.actualStart).getTime(), new Date(rec.startedAt).getTime());
    assert.equal(new Date(row.actualEnd).getTime(), new Date(rec.endedAt).getTime());
    assert.match(row.childName, /^(Mia|Sam|Eve) Khan$/);
    assert.ok(['BCBA', 'RBT'].includes(row.role));
    assert.equal(row.clinicianName, row.role === 'BCBA' ? 'Ada Lovelace' : 'Nia Patel');
    assert.ok(row.scheduledStart, 'scheduled window from the session’s own appointment');
  }
  const rbtRow = items.find((r) => r.role === 'RBT' && r.childName === 'Mia Khan');
  assert.equal(rbtRow.workedMinutes, 45); // 13:15 → 14:00
});

test('the list stays paged by cursor with no duplicates', { skip }, async () => {
  const seen = new Set(); let cursor;
  for (let i = 0; i < 10; i += 1) {
    const page = await sessionsService.listSessions({ tenantId: W.T, limit: 7, dataScope: ORG_SCOPE, ...(cursor ? { cursor } : {}) });
    page.items.forEach((r) => { assert.ok(!seen.has(r.id), 'duplicate row across pages'); seen.add(r.id); });
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.size, 30);
});

test('detail: same context, read in parallel stages, with the treatment plan name when linked', { skip }, async () => {
  const { items } = await sessionsService.listSessions({ tenantId: W.T, limit: 50, dataScope: ORG_SCOPE });
  const target = items.find((r) => r.id === W.planSession) ?? items[0];
  commands.length = 0;
  const detail = await sessionsService.getSession({ tenantId: W.T, sessionId: target.id, actorScope: ORG_SCOPE });
  assert.ok(commands.length <= 8, `detail used ${commands.length} commands`);
  assert.equal(detail.session.id, target.id);
  assert.equal(detail.display.childName, target.childName);
  assert.equal(detail.payroll.workedMinutes, target.workedMinutes, 'authoritative worked minutes');
  assert.ok(detail.display.bcbaName || detail.display.rbtName);
  assert.equal(detail.display.treatmentPlanName, 'Functional Communication Plan');
});

test('tenant isolation and clinician scope are unchanged', { skip }, async () => {
  const other = await sessionsService.listSessions({ tenantId: W.T2, limit: 50, dataScope: ORG_SCOPE });
  assert.equal(other.items.length, 1);
  assert.equal(other.items[0].childName, 'Leak Khan');
  const { items } = await sessionsService.listSessions({ tenantId: W.T, limit: 50, dataScope: ORG_SCOPE });
  assert.ok(!items.some((r) => r.childName === 'Leak Khan'));
  await assert.rejects(sessionsService.getSession({ tenantId: W.T2, sessionId: items[0].id, actorScope: ORG_SCOPE }), (e) => e.code === 'SESSION_NOT_FOUND');
  const rbtScope = { scope: 'SELF', staffProfileId: W.a.rbt, clientIds: W.a.clients, staffIds: [W.a.rbt] };
  const rbtRows = await sessionsService.listSessions({ tenantId: W.T, limit: 50, dataScope: rbtScope });
  assert.ok(rbtRows.items.length > 0);
});

test('RBAC unchanged: list and detail need sessions.read', { skip }, async () => {
  const router = createSessionsRouter({});
  const demanded = async (method, path) => {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    let error;
    await layer.route.stack[0].handle({ principal: { permissions: new Set() } }, {}, (e) => { error = e; });
    return /Missing permission: (\S+)/.exec(error?.message ?? '')?.[1];
  };
  assert.equal(await demanded('get', '/'), 'sessions.read');
  assert.equal(await demanded('get', '/:sessionId'), 'sessions.read');
});
