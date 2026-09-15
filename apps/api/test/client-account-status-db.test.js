import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * CLIENT ACCOUNT STATUS — against a REAL MongoDB.
 *
 * Account = Active when the client has a valid parent/guardian (name + mobile +
 * email), Hold when it doesn't or an admin placed the client on hold, Discharged
 * for discharged clients. The referral stage (Client.status REFERRED / INTAKE)
 * is never an account status and stays unchanged.
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

let server; let mongoose; let M; let withTenant; let clientsService; let alerts; let listClientsQuerySchema; let createClientsRouter;
const W = {};

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  ({ clientsService } = await import('../src/modules/clients/index.js'));
  alerts = await import('../src/modules/clients/clients.alerts.js');
  ({ listClientsQuerySchema } = await import('../src/modules/clients/clients.schemas.js'));
  ({ createClientsRouter } = await import('../src/modules/clients/clients.routes.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
  const org = (slug) => M.Organization.create({ slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: 'America/New_York', primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` });
  W.T = (await org('acct-acme'))._id;
  W.T2 = (await org('acct-other'))._id;

  const parent = (clientId, extra = {}) => M.Guardian.create({ clientId, firstName: 'Jane', lastName: 'Parent', phone: '5551234567', email: `p-${randomUUID()}@example.com`, relationship: 'PARENT', ...extra });
  const client = (n, first, status, extra = {}) => M.Client.create({ clientNumber: n, firstName: first, lastName: 'K', status, intakeWorkflowStatus: 'NOT_SENT', ...extra });
  await withTenant(W.T, async () => {
    W.referredReady = (await client('C-1', 'Raymond', 'REFERRED'))._id; await parent(W.referredReady);
    W.intakeNoParent = (await client('C-2', 'Ada', 'INTAKE'))._id;
    W.activeHalfParent = (await client('C-3', 'Cam', 'ACTIVE'))._id; await parent(W.activeHalfParent, { phone: null });
    W.onHoldReady = (await client('C-4', 'Eve', 'ON_HOLD'))._id; await parent(W.onHoldReady);
    W.discharged = (await client('C-5', 'Dee', 'DISCHARGED'))._id; await parent(W.discharged);
    W.deletedParent = (await client('C-6', 'Fay', 'ACTIVE', { intakeWorkflowStatus: 'COMPLETE' }))._id; await parent(W.deletedParent, { deletedAt: new Date() });
    W.archived = (await client('C-7', 'Gus', 'ACTIVE', { deletedAt: new Date() }))._id; await parent(W.archived);
  });
  await withTenant(W.T2, async () => {
    W.other = (await client('X-1', 'Leak', 'ACTIVE'))._id; await parent(W.other);
  });
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const EXPECTED = () => ({
  [W.referredReady]: 'ACTIVE',
  [W.intakeNoParent]: 'HOLD',
  [W.activeHalfParent]: 'HOLD',
  [W.onHoldReady]: 'HOLD',
  [W.discharged]: 'DISCHARGED',
  [W.deletedParent]: 'HOLD',
});
const list = (extra = {}) => clientsService.listClients({ tenantId: W.T, limit: 100, ...extra });

test('pure rule: discharged → DISCHARGED; on hold or no valid parent → HOLD; otherwise ACTIVE (referral stage never used)', () => {
  const d = alerts.deriveAccountStatus;
  assert.equal(d({ status: 'REFERRED', hasValidParent: true }), 'ACTIVE');
  assert.equal(d({ status: 'INTAKE', hasValidParent: true }), 'ACTIVE');
  assert.equal(d({ status: 'ACTIVE', hasValidParent: false }), 'HOLD');
  assert.equal(d({ status: 'REFERRED', hasValidParent: false }), 'HOLD');
  assert.equal(d({ status: 'ON_HOLD', hasValidParent: true }), 'HOLD');
  assert.equal(d({ status: 'DISCHARGED', hasValidParent: false }), 'DISCHARGED');
});

test('the list returns a derived accountStatus for every client; the referral stage is unchanged', { skip }, async () => {
  const { items } = await list();
  const byId = Object.fromEntries(items.map((c) => [c.id, c]));
  assert.deepEqual(Object.fromEntries(items.map((c) => [c.id, c.accountStatus])), EXPECTED());
  assert.equal(byId[W.referredReady].status, 'REFERRED', 'stage kept as stored');
  assert.ok(!items.some((c) => c.accountStatus === 'REFERRED' || c.accountStatus === 'INTAKE'));
  assert.ok(!byId[W.archived]);
});

test('accountStatus filter returns exactly the matching clients and combines with search, stage and scope', { skip }, async () => {
  const ids = async (extra) => (await list(extra)).items.map((c) => c.id).sort();
  const exp = EXPECTED();
  for (const status of ['ACTIVE', 'HOLD', 'DISCHARGED']) {
    assert.deepEqual(await ids({ accountStatus: status }), Object.keys(exp).filter((k) => exp[k] === status).sort(), status);
  }
  assert.deepEqual(await ids({ accountStatus: 'HOLD', search: 'Ada' }), [W.intakeNoParent]);
  assert.deepEqual(await ids({ accountStatus: 'ACTIVE', status: 'REFERRED' }), [W.referredReady]);
  assert.deepEqual(await ids({ accountStatus: 'HOLD', status: 'REFERRED' }), []);
  assert.deepEqual(await ids({ accountStatus: 'HOLD', clientIds: [W.onHoldReady, W.referredReady] }), [W.onHoldReady]);
  assert.deepEqual(await ids({ accountStatus: 'ACTIVE', clientIds: [] }), []);
});

test('summary counts use the same rule, honour scope, and exclude archived clients', { skip }, async () => {
  const s = await clientsService.summarizeClients({ tenantId: W.T });
  assert.deepEqual(s.account, { ACTIVE: 1, HOLD: 4, DISCHARGED: 1 });
  assert.equal(s.total, 6);
  assert.deepEqual(s.stage, { REFERRED: 1, INTAKE: 1, ACTIVE: 2, ON_HOLD: 1, DISCHARGED: 1 });
  const scoped = await clientsService.summarizeClients({ tenantId: W.T, clientIds: [W.referredReady, W.intakeNoParent] });
  assert.deepEqual([scoped.total, scoped.account], [2, { ACTIVE: 1, HOLD: 1, DISCHARGED: 0 }]);
});

test('client detail carries the same accountStatus', { skip }, async () => {
  for (const [id, expected] of Object.entries(EXPECTED())) {
    const d = await clientsService.getClient({ tenantId: W.T, clientId: id });
    assert.equal(d.client.accountStatus, expected, id);
  }
});

test('adding a valid parent makes the account Active; removing it returns it to Hold (reusing the guardian APIs)', { skip }, async () => {
  const g = await clientsService.addGuardian({ tenantId: W.T, clientId: W.intakeNoParent, actorUserId: 'admin', input: { firstName: 'Jane', lastName: 'Doe', phone: '5550001111', email: 'jane.doe@example.com', relationship: 'PARENT' } });
  let item = (await list({ search: 'Ada' })).items[0];
  assert.equal(item.accountStatus, 'ACTIVE');
  assert.equal(item.status, 'INTAKE', 'the referral stage is independent');
  await clientsService.removeGuardian({ tenantId: W.T, clientId: W.intakeNoParent, guardianId: g.id, actorUserId: 'admin' });
  item = (await list({ search: 'Ada' })).items[0];
  assert.equal(item.accountStatus, 'HOLD');
});

test('the Mongo query form of the parent rule matches isValidParent exactly', { skip }, async () => {
  const cases = [
    { firstName: 'A', lastName: 'B', phone: '1', email: 'e@x.io' },
    { firstName: 'A', lastName: 'B', phone: null, email: 'e@x.io' },
    { firstName: 'A', lastName: 'B', phone: '1', email: null },
    { firstName: 'A', lastName: 'B', phone: '1', email: '' },
    { firstName: 'A', lastName: 'B', phone: '1', email: 'e@x.io', deletedAt: new Date() },
  ];
  await withTenant(W.T, async () => {
    for (const [i, c] of cases.entries()) {
      const clientId = (await M.Client.create({ clientNumber: `EQ-${i}`, firstName: 'Eq', lastName: String(i), status: 'REFERRED' }))._id;
      const doc = await M.Guardian.create({ clientId, relationship: 'PARENT', ...c });
      const viaQuery = (await M.Guardian.countDocuments({ _id: doc._id, ...alerts.VALID_PARENT_GUARDIAN_QUERY })) === 1;
      const viaRule = !c.deletedAt && alerts.isValidParent(c);
      assert.equal(viaQuery, viaRule, JSON.stringify(c));
    }
  });
});

test('tenant isolation: another tenant sees only its own clients and counts', { skip }, async () => {
  const other = await clientsService.listClients({ tenantId: W.T2, limit: 100 });
  assert.deepEqual(other.items.map((c) => [c.id, c.accountStatus]), [[W.other, 'ACTIVE']]);
  const s = await clientsService.summarizeClients({ tenantId: W.T2 });
  assert.equal(s.total, 1);
  await assert.rejects(clientsService.getClient({ tenantId: W.T2, clientId: W.referredReady }), (e) => e.code === 'CLIENT_NOT_FOUND');
});

test('API contract: accountStatus query is validated; GET /summary is guarded by clients.read and mounted before /:clientId', { skip }, () => {
  assert.equal(listClientsQuerySchema.safeParse({ accountStatus: 'HOLD' }).success, true);
  assert.equal(listClientsQuerySchema.safeParse({ accountStatus: 'REFERRED' }).success, false);
  const router = createClientsRouter({});
  const paths = router.stack.filter((l) => l.route?.methods.get).map((l) => l.route.path);
  assert.ok(paths.indexOf('/summary') > -1 && paths.indexOf('/summary') < paths.indexOf('/:clientId'));
  const summary = router.stack.find((l) => l.route?.path === '/summary');
  assert.equal(summary.route.stack.length, 2, 'permission guard + handler');
});
