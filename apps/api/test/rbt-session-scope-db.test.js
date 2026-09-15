import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { scopeSessionsFilter } from '../src/modules/rbac/scopeFilters.js';
import { sessionVisibleToScope } from '../src/modules/rbac/dataScope.js';

/**
 * CROSS-CLINICIAN SESSION ACCESS — enforced server-side on the list, Session
 * Insights and every by-id session route (GET/PATCH/freeze …):
 *
 *   BCBA = own sessions + RBT sessions on children the BCBA is assigned to
 *   RBT  = own sessions only
 *
 * Tenant-scoped throughout; authorization comes from the token and persisted
 * care-team assignments, never from request parameters.
 */
test('scopeSessionsFilter: SELF = own; TEAM = own + RBT sessions on led children; ORG unchanged; fails closed', () => {
  assert.deepEqual(scopeSessionsFilter({}, { scope: 'SELF', staffIds: ['rbt-1'], clientIds: ['c-1'] }), { $and: [{ staffProfileId: { $in: ['rbt-1'] } }] });
  assert.deepEqual(scopeSessionsFilter({}, { scope: 'SELF', staffIds: [], clientIds: ['c-1'] }), { $and: [{ staffProfileId: { $in: [] } }] });
  assert.deepEqual(scopeSessionsFilter({ status: 'FROZEN' }, { scope: 'SELF', staffIds: ['rbt-1'], clientIds: [] }), { status: 'FROZEN', $and: [{ staffProfileId: { $in: ['rbt-1'] } }] });
  assert.deepEqual(
    scopeSessionsFilter({}, { scope: 'TEAM', staffProfileId: 'bcba-1', staffIds: ['bcba-1', 'rbt-9'], clientIds: ['c-1', 'c-9'], sessionReviewPairs: [{ clientId: 'c-1', staffIds: ['rbt-1'] }] }),
    { $and: [{ $or: [{ staffProfileId: 'bcba-1' }, { clientId: 'c-1', staffProfileId: { $in: ['rbt-1'] } }] }] },
  );
  // Unresolved pairs → own sessions only (never the wider caseload rule).
  assert.deepEqual(scopeSessionsFilter({}, { scope: 'TEAM', staffProfileId: 'bcba-1', staffIds: ['bcba-1'], clientIds: ['c-1'] }), { $and: [{ $or: [{ staffProfileId: 'bcba-1' }] }] });
  assert.deepEqual(scopeSessionsFilter({}, { scope: 'ORGANIZATION', staffIds: null, clientIds: null }), {});
});

test('sessionVisibleToScope: the by-id rule', () => {
  const bcba = { scope: 'TEAM', staffProfileId: 'bcba-1', sessionReviewPairs: [{ clientId: 'c-1', staffIds: ['rbt-1'] }] };
  assert.equal(sessionVisibleToScope(bcba, { clientId: 'c-1', staffProfileId: 'bcba-1' }), true);   // own
  assert.equal(sessionVisibleToScope(bcba, { clientId: 'c-1', staffProfileId: 'rbt-1' }), true);    // RBT on led child
  assert.equal(sessionVisibleToScope(bcba, { clientId: 'c-2', staffProfileId: 'rbt-1' }), false);   // same RBT, other child
  assert.equal(sessionVisibleToScope(bcba, { clientId: 'c-1', staffProfileId: 'bcba-2' }), false);  // another BCBA, same child
  const rbt = { scope: 'SELF', staffProfileId: 'rbt-1', staffIds: ['rbt-1'] };
  assert.equal(sessionVisibleToScope(rbt, { clientId: 'c-1', staffProfileId: 'rbt-1' }), true);
  assert.equal(sessionVisibleToScope(rbt, { clientId: 'c-1', staffProfileId: 'bcba-1' }), false);
  assert.equal(sessionVisibleToScope({ scope: 'SELF', staffProfileId: null }, { clientId: 'c-1', staffProfileId: null }), false);
});

process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS ?? '4';
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';
const TZ = 'America/New_York';
let server; let mongoose; let httpServer; let base;
const W = { tok: {}, s: {} };

const call = async (who, path, init = {}) => {
  const res = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${W.tok[who]}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
};
const rows = (r) => (Array.isArray(r.json?.data) ? r.json.data : r.json?.data?.items) ?? [];
const listIds = async (who) => rows(await call(who, '/api/v1/sessions?limit=100')).map((x) => x.id).sort();
const detail = async (who, key) => (await call(who, `/api/v1/sessions/${W.s[key]}`)).status;

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  const M = await import('../src/models/index.js');
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
  const { withTenant } = await import('../src/tenancy/tenantContext.js');
  const { usersRepository } = await import('../src/modules/users/index.js');
  const { hashPassword } = await import('../src/utils/password.js');
  const { clientsService } = await import('../src/modules/clients/index.js');
  const { BcbaSessionService, bcbaSessionService } = await import('../src/modules/bcba-session/index.js');
  const { createApp } = await import('../src/app.js');
  const passwordHash = await hashPassword('Str0ng-Passw0rd!');
  const live = new BcbaSessionService({ ...bcbaSessionService.deps, clock: { now: () => new Date('2026-09-15T16:00:00Z') } });

  /**
   * Tenant "John Doe clinic":
   *   John Doe  — BCBA A (lead), BCBA C (second lead), RBT B, RBT D
   *   Mia Khan  — BCBA E (lead), RBT F;  BCBA A supervises RBT F but is NOT assigned to Mia
   * Tenant "Other clinic": BCBA X, RBT Y on their own child.
   */
  const seedTenant = async (slug, people, children) => {
    const T = (await M.Organization.create({ slug, legalName: `${slug} LLC`, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: TZ, primaryContactName: 'O', primaryContactEmail: `o@${slug}.test` }))._id;
    const staff = {};
    for (const [key, roleKey, first] of people) {
      const userId = randomUUID();
      await usersRepository.createActiveAccountWithPassword({ userId, membershipId: randomUUID(), tenantId: T, email: `${key}@${slug}.test`, fullName: first, passwordHash, roleKey });
      staff[key] = (await withTenant(T, () => M.StaffProfile.create({ userId, firstName: first, lastName: slug, status: 'ACTIVE' })))._id;
    }
    const kids = {};
    for (const [key, first, team] of children) {
      const c = await withTenant(T, async () => {
        const client = await M.Client.create({ clientNumber: `C-${key}`, firstName: first, lastName: 'Doe', status: 'ACTIVE' });
        await M.Guardian.create({ clientId: client._id, firstName: 'P', lastName: 'Doe', phone: '5551234567', email: `p.${key}@${slug}.test`, relationship: 'PARENT', isPrimary: true });
        for (const [staffKey, role] of team) await M.ClientAssignment.create({ clientId: client._id, staffProfileId: staff[staffKey], role, status: 'ACTIVE' });
        return client;
      });
      const auth = await clientsService.createServiceAuthorization({ tenantId: T, clientId: c._id, actorUserId: randomUUID(), input: { serviceType: 'ABA', authorizationNumber: `AUTH-${key}`, units: 800, billingCode: '97153', startDate: '2026-08-01', endDate: '2026-12-31' } });
      kids[key] = { id: c._id, auth: auth.id };
    }
    const session = async (key, staffKey, role, kid, date, start) => {
      const r = await live.createManualSession({ tenantId: T, actorUserId: randomUUID(), bcbaStaffProfileId: staff[staffKey], role, input: { clientId: kids[kid].id, date, startTime: start, endTime: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, memo: `${key} memo`, authorizationIds: [`svc:${kids[kid].auth}`] } });
      W.s[key] = r?.sessionId ?? r?.id ?? r?.session?.id;
    };
    return { T, staff, session };
  };

  const A = await seedTenant('johndoe', [['bcbaA', 'bcba', 'Ana'], ['bcbaC', 'bcba', 'Cal'], ['bcbaE', 'bcba', 'Eve'], ['rbtB', 'rbt', 'Ben'], ['rbtD', 'rbt', 'Dee'], ['rbtF', 'rbt', 'Fay']],
    [['john', 'John', [['bcbaA', 'BCBA'], ['bcbaC', 'BCBA'], ['rbtB', 'RBT'], ['rbtD', 'RBT']]], ['mia', 'Mia', [['bcbaE', 'BCBA'], ['rbtF', 'RBT']]]]);
  await withTenant(A.T, () => M.SupervisionLink.create({ supervisorStaffId: A.staff.bcbaA, superviseeStaffId: A.staff.rbtF, active: true }));
  await A.session('bcbaA_john', 'bcbaA', 'BCBA', 'john', '2026-09-10', '08:00');
  await A.session('bcbaC_john', 'bcbaC', 'BCBA', 'john', '2026-09-10', '09:00');
  await A.session('rbtB_john', 'rbtB', 'RBT', 'john', '2026-09-10', '10:00');
  await A.session('rbtD_john', 'rbtD', 'RBT', 'john', '2026-09-10', '12:00');
  await A.session('rbtF_mia', 'rbtF', 'RBT', 'mia', '2026-09-10', '14:00');

  const B = await seedTenant('otherclinic', [['bcbaX', 'bcba', 'Xan'], ['rbtY', 'rbt', 'Yas']], [['kid', 'Kid', [['bcbaX', 'BCBA'], ['rbtY', 'RBT']]]]);
  await B.session('rbtY_kid', 'rbtY', 'RBT', 'kid', '2026-09-10', '10:00');

  httpServer = http.createServer(createApp()).listen(0);
  await new Promise((r) => httpServer.once('listening', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
  const signIn = async (email) => (await (await fetch(`${base}/api/v1/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Str0ng-Passw0rd!' }) })).json()).data.accessToken;
  for (const k of ['bcbaA', 'bcbaC', 'bcbaE', 'rbtB', 'rbtD', 'rbtF']) W.tok[k] = await signIn(`${k}@johndoe.test`);
  for (const k of ['bcbaX', 'rbtY']) W.tok[k] = await signIn(`${k}@otherclinic.test`);
  W.tok.admin = await (async () => { await usersRepository.createActiveAccountWithPassword({ userId: randomUUID(), membershipId: randomUUID(), tenantId: A.T, email: 'admin@johndoe.test', fullName: 'Admin', passwordHash, roleKey: 'org_admin' }); return signIn('admin@johndoe.test'); })();
});
after(async () => { httpServer?.close(); await mongoose?.disconnect(); await server?.stop(); });

test('seeded every session', { skip }, () => {
  for (const k of ['bcbaA_john', 'bcbaC_john', 'rbtB_john', 'rbtD_john', 'rbtF_mia', 'rbtY_kid']) assert.ok(W.s[k], `missing ${k}`);
});

test('1. BCBA → own BCBA session: ALLOW', { skip }, async () => {
  assert.equal(await detail('bcbaA', 'bcbaA_john'), 200);
});

test('2. BCBA → the assigned child’s RBT session: ALLOW, with the existing Session Detail data', { skip }, async () => {
  const r = await call('bcbaA', `/api/v1/sessions/${W.s.rbtB_john}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.id ?? r.json.data.session?.id, W.s.rbtB_john);
  assert.equal(await detail('bcbaA', 'rbtD_john'), 200);
});

test('3. BCBA → an unassigned child’s RBT session: DENY (even when supervising that RBT)', { skip }, async () => {
  assert.equal(await detail('bcbaA', 'rbtF_mia'), 404);
  assert.equal(await detail('bcbaE', 'rbtB_john'), 404); // a BCBA not assigned to John Doe
});

test('BCBA → another BCBA’s session on the same child: DENY', { skip }, async () => {
  assert.equal(await detail('bcbaA', 'bcbaC_john'), 404);
});

test('4. RBT → own RBT session: ALLOW', { skip }, async () => {
  assert.equal(await detail('rbtB', 'rbtB_john'), 200);
});

test('5. RBT → the same child’s BCBA session: DENY', { skip }, async () => {
  assert.equal(await detail('rbtB', 'bcbaA_john'), 404);
});

test('6. RBT → another RBT’s session (same child): DENY', { skip }, async () => {
  assert.equal(await detail('rbtB', 'rbtD_john'), 404);
});

test('7–8. Cross-tenant BCBA and RBT → session: DENY', { skip }, async () => {
  for (const who of ['bcbaX', 'rbtY']) {
    for (const key of ['bcbaA_john', 'rbtB_john']) assert.equal(await detail(who, key), 404, `${who} → ${key}`);
  }
  assert.equal(await detail('bcbaA', 'rbtY_kid'), 404);
});

test('writes follow the same rule (BCBA may update the RBT session on their child; RBT may not touch the BCBA session)', { skip }, async () => {
  const rbtPatch = await call('rbtB', `/api/v1/sessions/${W.s.bcbaA_john}`, { method: 'PATCH', body: JSON.stringify({}) });
  assert.equal(rbtPatch.status === 404 || rbtPatch.status === 403, true, `RBT PATCH BCBA session → ${rbtPatch.status}`);
  const otherBcba = await call('bcbaE', `/api/v1/sessions/${W.s.rbtB_john}/freeze`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(otherBcba.status, 404);
  // The assigned BCBA passes the access guard for the same write (it may still
  // be refused by the session's own business rules, but never as "not found").
  const assignedBcba = await call('bcbaA', `/api/v1/sessions/${W.s.rbtB_john}/freeze`, { method: 'POST', body: JSON.stringify({}) });
  assert.notEqual(assignedBcba.status, 404, `assigned BCBA freeze → ${assignedBcba.status} ${JSON.stringify(assignedBcba.json).slice(0, 160)}`);
  assert.notEqual(assignedBcba.status, 403);
});

test('lists and insights match detail access; admin keeps the organization view', { skip }, async () => {
  assert.deepEqual(await listIds('bcbaA'), [W.s.bcbaA_john, W.s.rbtB_john, W.s.rbtD_john].sort());
  assert.deepEqual(await listIds('bcbaE'), [W.s.rbtF_mia].sort());
  assert.deepEqual(await listIds('rbtB'), [W.s.rbtB_john]);
  assert.deepEqual(await listIds('bcbaX'), [W.s.rbtY_kid]);
  const insights = (await call('bcbaA', '/api/v1/sessions/oversight/insights')).json.data;
  assert.equal(insights.totals.sessions, 3);
  assert.equal(insights.totals.bcbaSessions, 1);
  assert.equal(insights.totals.rbtSessions, 2);
  assert.equal((await listIds('admin')).length, 5);
});

test('Session Detail names: BCBA sees the child’s assigned RBT(s); RBT never receives the BCBA', { skip }, async () => {
  const own = (await call('bcbaA', `/api/v1/sessions/${W.s.bcbaA_john}`)).json.data;
  assert.equal(own.display.bcbaName, 'Ana johndoe');
  assert.deepEqual(own.display.rbtName.split(', ').sort(), ['Ben johndoe', 'Dee johndoe']);   // John Doe’s active RBTs

  const rbtSession = (await call('bcbaA', `/api/v1/sessions/${W.s.rbtB_john}`)).json.data;
  assert.equal(rbtSession.display.rbtName, 'Ben johndoe');

  const rbtOwn = (await call('rbtB', `/api/v1/sessions/${W.s.rbtB_john}`)).json.data;
  assert.equal(rbtOwn.display.rbtName, 'Ben johndoe');
  assert.equal(rbtOwn.display.bcbaName, null);
  assert.equal(JSON.stringify(rbtOwn).includes('Ana'), false);
  assert.equal(JSON.stringify(rbtOwn).includes('Cal'), false);
});
