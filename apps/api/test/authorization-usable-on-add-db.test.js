import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * AUTHORIZATION — usable the moment it is added (real MongoDB).
 *
 *   Add Authorization → persisted (payer workflow NOT_SENT, never faked) →
 *   listed for the client → usable by booking and BCBA/RBT manual sessions
 *   → billable — with NO review / approve step.
 *
 * Only a DENIED or archived authorization is refused. The date window and
 * remaining units are still enforced.
 */

const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

const TZ = 'America/New_York';
let server; let mongoose; let M; let withTenant; let zonedWallTimeToUtc;
let clientsService; let schedulingService; let SchedulingService; let schedulingRepository; let bcbaSessionService; let claimsService;
const W = {};

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  ({ zonedWallTimeToUtc } = await import('../src/domain/businessDate.js'));
  ({ clientsService } = await import('../src/modules/clients/index.js'));
  ({ schedulingService, SchedulingService, schedulingRepository } = await import('../src/modules/scheduling/index.js'));
  ({ bcbaSessionService } = await import('../src/modules/bcba-session/index.js'));
  ({ claimsService } = await import('../src/modules/claims/index.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));

  const o = await M.Organization.create({
    slug: 'auth-usable', legalName: 'auth-usable', tradingName: 'auth-usable', state: 'ACTIVE', countryCode: 'US', timezone: TZ,
    primaryContactName: 'Owner', primaryContactEmail: 'auth-usable@example.com',
  });
  W.T = o._id;
  await withTenant(W.T, async () => {
    const bcba = await M.StaffProfile.create({ userId: randomUUID(), firstName: 'Test1', lastName: 'J' });
    const rbt = await M.StaffProfile.create({ userId: randomUUID(), firstName: 'Nia', lastName: 'Patel' });
    const client = await M.Client.create({ clientNumber: 'C-AU', firstName: 'Raymond', lastName: 'K', status: 'ACTIVE' });
    await M.Guardian.create({ clientId: client._id, firstName: 'Jane', lastName: 'K', phone: '5551234567', email: 'jane.k@example.com', relationship: 'PARENT', isPrimary: true });
    await M.ClientAssignment.create({ clientId: client._id, staffProfileId: bcba._id, role: 'BCBA', status: 'ACTIVE' });
    await M.ClientAssignment.create({ clientId: client._id, staffProfileId: rbt._id, role: 'RBT', status: 'ACTIVE' });
    Object.assign(W, { bcba: bcba._id, rbt: rbt._id, client: client._id });
  });
});

after(async () => {
  if (skip) return;
  await mongoose?.disconnect();
  await server?.stop();
});

const addAuth = (number, extra = {}) => clientsService.createServiceAuthorization({
  tenantId: W.T, clientId: W.client, actorUserId: randomUUID(),
  input: {
    serviceType: 'ABA', authorizationNumber: number, billingCode: '97153', units: 400, unitPrice: 1800,
    startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-30T00:00:00.000Z', ...extra,
  },
});
const manual = (staff, role, input) => bcbaSessionService.createManualSession({
  tenantId: W.T, actorUserId: randomUUID(), bcbaStaffProfileId: staff, role,
  input: { clientId: W.client, date: '2026-09-10', startTime: '10:15', endTime: '11:45', memo: 'Session memo', ...input },
});
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code); return true; });

test('an added authorization persists in its real state and is listed as usable at once', { skip }, async () => {
  const created = await addAuth('AU-LIST');
  assert.equal(created.status, 'NOT_SENT', 'the real payer-workflow state — no fabricated approval');
  const stored = await withTenant(W.T, async () => await M.ServiceAuthorization.findById(created.id).lean());
  assert.equal(stored.status, 'NOT_SENT');
  assert.equal(stored.history.length, 0, 'no transition was performed');

  const listed = await schedulingRepository.listAuthorizations(W.T, { clientId: W.client });
  const row = listed.items.find((a) => a.id === `svc:${created.id}`);
  assert.ok(row, 'appears in the client authorization list');
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.workflowStatus, 'NOT_SENT');
});

test('BCBA and RBT manual sessions can use a just-added (NOT_SENT) authorization', { skip }, async () => {
  const auth = await addAuth('AU-MANUAL');
  const b = await manual(W.bcba, 'BCBA', { authorizationIds: [`svc:${auth.id}`] });
  const r = await manual(W.rbt, 'RBT', { authorizationIds: [`svc:${auth.id}`], startTime: '13:00', endTime: '14:00' });
  for (const res of [b, r]) {
    const session = await withTenant(W.T, async () => await M.Session.findById(res.session.id).lean());
    assert.deepEqual(session.selectedAuthorizationIds, [`svc:${auth.id}`]);
    const record = await withTenant(W.T, async () => await M.SessionTimeRecord.findOne({ sessionId: res.session.id }).lean());
    assert.ok(record, 'SessionTimeRecord written');
  }
  const still = await withTenant(W.T, async () => await M.ServiceAuthorization.findById(auth.id).lean());
  assert.equal(still.status, 'NOT_SENT', 'using it never changes its workflow state');
});

test('a booking can use a just-added (SENT, not yet approved) authorization', { skip }, async () => {
  const auth = await addAuth('AU-BOOK');
  await clientsService.transitionServiceAuthorization({ tenantId: W.T, clientId: W.client, authorizationId: auth.id, actorUserId: randomUUID(), target: 'SENT' });
  const pinned = new SchedulingService({ ...schedulingService.deps, clock: { now: () => zonedWallTimeToUtc(2026, 9, 14, 9, 0, 0, TZ) } });
  const appt = await pinned.bookAppointment({
    tenantId: W.T, actorUserId: randomUUID(),
    input: { clientId: W.client, bcbaId: W.bcba, authorizationIds: [`svc:${auth.id}`], units: 4, startDate: '2026-09-15' },
  });
  assert.ok(appt.id);
  const used = await withTenant(W.T, async () => await M.ServiceAuthorization.findById(auth.id).lean());
  assert.equal(used.usedUnits, 4, 'units burn down against the same record');
});

test('a DENIED or archived authorization is refused; nothing is written', { skip }, async () => {
  const denied = await addAuth('AU-DENIED');
  for (const target of ['SENT', 'DENIED']) {
    await clientsService.transitionServiceAuthorization({ tenantId: W.T, clientId: W.client, authorizationId: denied.id, actorUserId: randomUUID(), target, reason: 'Payer denied' });
  }
  const before = await withTenant(W.T, async () => await M.Session.countDocuments({}));
  await rejectsCode(manual(W.bcba, 'BCBA', { authorizationIds: [`svc:${denied.id}`], date: '2026-09-11' }), 'AUTHORIZATION_NOT_USABLE');

  const archived = await addAuth('AU-ARCHIVED');
  await withTenant(W.T, async () => await M.ServiceAuthorization.updateOne({ _id: archived.id }, { $set: { deletedAt: new Date() } }));
  await rejectsCode(manual(W.bcba, 'BCBA', { authorizationIds: [`svc:${archived.id}`], date: '2026-09-11' }), 'AUTHORIZATION_NOT_FOR_CLIENT');
  assert.equal(await withTenant(W.T, async () => await M.Session.countDocuments({})), before);
});

test('the date window still applies to a just-added authorization', { skip }, async () => {
  const auth = await addAuth('AU-WINDOW');
  await rejectsCode(manual(W.bcba, 'BCBA', { authorizationIds: [`svc:${auth.id}`], date: '2026-10-02' }), 'AUTHORIZATION_NOT_VALID_FOR_DATE');
});
