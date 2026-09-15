import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * CLIENT INTAKE PIPELINE — against a REAL MongoDB, through the production
 * singletons the intake screen calls (clientsService, insuranceService):
 *
 *   1 client (first/middle/last) → 2 guardian → 3 address → 4 insurance → 5 authorization
 *
 * Proves the existing models/rules, not a new flow: separate name fields,
 * optional middle name, one guardian per identical submission, insurance refused
 * until a VALID parent exists, an authorization saved and listed immediately,
 * activation gated on a valid parent, and a parent removal demoting (never
 * deleting) the client. Skipped without a local mongod.
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

let server; let mongoose; let M; let withTenant; let clientsService; let insuranceService;
let T; let T2;
const actorUserId = randomUUID();

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withTenant } = await import('../src/tenancy/tenantContext.js'));
  ({ clientsService } = await import('../src/modules/clients/index.js'));
  ({ insuranceService } = await import('../src/modules/clients/insurance.service.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
  const org = (slug) => M.Organization.create({
    slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: 'America/New_York',
    primaryContactName: 'Owner', primaryContactEmail: `${slug}@example.com`,
  });
  T = (await org('intake-org'))._id;
  T2 = (await org('intake-other'))._id;
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const PARENT = { firstName: 'Jane', lastName: 'Smith', phone: '5551234567', email: 'jane@example.com', relationship: 'PARENT', isPrimary: true };
const newClient = (input) => clientsService.createClient({ tenantId: T, actorUserId, input: { firstName: 'John', lastName: 'Smith', ...input } });

test('step 1: first / middle / last persist as separate fields; middle name is optional', { skip }, async () => {
  const withMiddle = await newClient({ middleName: 'Michael' });
  const without = await newClient({ firstName: 'Ana', lastName: 'Lee' });
  const [a, b] = await withTenant(T, async () => [await M.Client.findById(withMiddle.id).lean(), await M.Client.findById(without.id).lean()]);
  assert.deepEqual([a.firstName, a.middleName, a.lastName], ['John', 'Michael', 'Smith']);
  assert.deepEqual([b.firstName, b.lastName], ['Ana', 'Lee']);
  assert.ok(b.middleName == null);
  assert.equal(a.status, 'REFERRED', 'a new client is not active');
  await assert.rejects(newClient({ status: 'ACTIVE' }), (e) => e.code === 'CLIENT_ACTIVATION_REQUIRES_PARENT');
});

test('steps 2–5 end to end: guardian (no duplicates) → address → insurance gated on parent → authorization saved immediately', { skip }, async () => {
  const c = await newClient({ middleName: 'Michael' });

  // Step 4 before a parent exists: refused on the server.
  const coverage = { payerName: 'Acme Health', memberId: 'M-1', subscriberRelationship: 'PARENT' };
  await assert.rejects(
    insuranceService.create({ tenantId: T, clientId: c.id, actorUserId, input: coverage }),
    (e) => e.code === 'PARENT_DETAILS_REQUIRED' && e.status === 422 && /parent or guardian details/.test(e.message),
  );
  // A half-complete guardian (no email) is not a valid parent either.
  await clientsService.addGuardian({ tenantId: T, clientId: c.id, actorUserId, input: { firstName: 'Half', lastName: 'Parent', phone: '5550000000' } });
  await assert.rejects(insuranceService.create({ tenantId: T, clientId: c.id, actorUserId, input: coverage }), (e) => e.code === 'PARENT_DETAILS_REQUIRED');
  // Authorization has the same parent prerequisite, and writes nothing.
  await assert.rejects(
    clientsService.createServiceAuthorization({ tenantId: T, clientId: c.id, actorUserId, input: { serviceType: 'ABA', authorizationNumber: 'AUTH-EARLY' } }),
    (e) => e.code === 'PARENT_DETAILS_REQUIRED' && e.status === 422,
  );
  assert.equal(await withTenant(T, async () => await M.ServiceAuthorization.countDocuments({ clientId: c.id })), 0);

  // Step 2: the same parent submitted twice (retry / double click) → ONE guardian.
  const g1 = await clientsService.addGuardian({ tenantId: T, clientId: c.id, actorUserId, input: PARENT });
  const g2 = await clientsService.addGuardian({ tenantId: T, clientId: c.id, actorUserId, input: { ...PARENT, email: 'JANE@example.com', phone: '(555) 123-4567' } });
  assert.equal(g2.id, g1.id);
  const guardians = await withTenant(T, async () => M.Guardian.find({ clientId: c.id, deletedAt: null }).lean());
  assert.equal(guardians.length, 2, 'the half parent + ONE Jane');
  const client = await withTenant(T, async () => M.Client.findById(c.id).lean());
  assert.equal(client.primaryGuardianId, g1.id, 'the Client ↔ Guardian relationship is the existing one');

  // Step 3: address on the existing client structure.
  const updated = await clientsService.updateClient({ tenantId: T, clientId: c.id, actorUserId, expectedVersion: client.version, input: { address: { line1: '12 Oak St', city: 'Austin', state: 'TX', postalCode: '78701' } } });
  assert.equal(updated.address.city, 'Austin');

  // Step 4 with a valid parent: accepted, one record.
  const cov = await insuranceService.create({ tenantId: T, clientId: c.id, actorUserId, input: coverage });
  assert.equal(cov.verificationStatus, 'VERIFIED'); // saved insurance is active immediately

  // Step 5: Add Authorization → persisted and listed immediately.
  const auth = await clientsService.createServiceAuthorization({ tenantId: T, clientId: c.id, actorUserId, input: { serviceType: 'ABA', authorizationNumber: 'AUTH-77', units: 120, startDate: '2026-09-01', endDate: '2026-12-31' } });
  const listed = await clientsService.listServiceAuthorizations({ tenantId: T, clientId: c.id });
  assert.deepEqual(listed.map((a) => a.id), [auth.id]);
  assert.equal(listed[0].authorizationNumber, 'AUTH-77');
  assert.equal(listed[0].status, 'NOT_SENT', 'the real lifecycle state — no fabricated approval');
});

test('account status: activation needs a valid parent; removing it demotes (never deletes) the client', { skip }, async () => {
  const c = await newClient({});
  const v = async () => (await withTenant(T, async () => M.Client.findById(c.id).lean())).version;
  await assert.rejects(
    clientsService.updateClient({ tenantId: T, clientId: c.id, actorUserId, expectedVersion: await v(), input: { status: 'ACTIVE' } }),
    (e) => e.code === 'CLIENT_ACTIVATION_REQUIRES_PARENT',
  );
  const g = await clientsService.addGuardian({ tenantId: T, clientId: c.id, actorUserId, input: PARENT });
  const active = await clientsService.updateClient({ tenantId: T, clientId: c.id, actorUserId, expectedVersion: await v(), input: { status: 'ACTIVE' } });
  assert.equal(active.status, 'ACTIVE');
  await clientsService.removeGuardian({ tenantId: T, clientId: c.id, guardianId: g.id, actorUserId });
  const after = await withTenant(T, async () => M.Client.findById(c.id).lean());
  assert.equal(after.status, 'ON_HOLD');
  assert.equal(after.deletedAt ?? null, null);
});

test('tenant isolation: another tenant cannot add a guardian or insurance to this client', { skip }, async () => {
  const c = await newClient({});
  await assert.rejects(clientsService.addGuardian({ tenantId: T2, clientId: c.id, actorUserId, input: PARENT }), (e) => /NOT_FOUND/.test(e.code));
  await assert.rejects(insuranceService.create({ tenantId: T2, clientId: c.id, actorUserId, input: { payerName: 'X', memberId: '1', subscriberRelationship: 'PARENT' } }), (e) => e.code === 'PARENT_DETAILS_REQUIRED' || /NOT_FOUND/.test(e.code));
  assert.equal(await withTenant(T2, async () => M.InsuranceCoverage.countDocuments({ clientId: c.id })), 0);
});
