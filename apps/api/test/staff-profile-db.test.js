import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * STAFF PROFILE API (GET / PATCH /staff/:staffId) — against a REAL MongoDB.
 *
 * Drives the production staffService + repository + models. Verifies:
 *  - the detail is scoped by the resolved staff.read data scope (404 outside it)
 *  - tenant isolation
 *  - pay rate only for pay-authorised viewers; caseload only when requested
 *  - caseload = ACTIVE assignments of non-archived clients, this tenant only
 *  - the existing update API: clearable optional fields, reversible status
 *    change, optimistic concurrency, strict body (no tenant/employee fields)
 *  - no secrets in the response
 */

const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

let server; let mongoose; let M; let withTenant; let withPlatform; let staffService; let updateStaffSchema;
const W = {};

before(async () => {
  if (skip) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { systemBinary: MONGOD } });
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(server.getUri());
  M = await import('../src/models/index.js');
  ({ withTenant, withPlatform } = await import('../src/tenancy/tenantContext.js'));
  ({ staffService } = await import('../src/modules/staff/index.js'));
  ({ updateStaffSchema } = await import('../src/modules/staff/staff.schemas.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));

  const org = (slug) => M.Organization.create({ slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: 'America/New_York', primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` });
  W.T = (await org('staff-acme'))._id;
  W.T2 = (await org('staff-other'))._id;

  const userId = randomUUID();
  await withPlatform(async () => M.User.create({ _id: userId, email: 'ada.bcba@example.com', fullName: 'Ada Lovelace', passwordHash: 'hash-secret', mustChangePassword: false, status: 'ACTIVE' }));

  await withTenant(W.T, async () => {
    const ada = await M.StaffProfile.create({ userId, firstName: 'Ada', middleName: 'King', lastName: 'Lovelace', title: 'Lead BCBA', employeeNumber: 'EMP-0001', status: 'ACTIVE', startDate: new Date('2026-02-01') });
    const role = await M.Role.create({ key: 'bcba', name: 'BCBA' });
    const membership = await M.Membership.create({ userId, status: 'ACTIVE' });
    await M.MembershipRole.create({ membershipId: membership._id, roleId: role._id });
    await M.PayRate.create({ staffProfileId: ada._id, rateType: 'HOURLY', amount: 6250, effectiveFrom: new Date('2026-01-01') });
    const other = await M.StaffProfile.create({ userId: randomUUID(), firstName: 'Nia', lastName: 'Patel', status: 'ACTIVE' });

    const client = (n, first, extra = {}) => M.Client.create({ clientNumber: n, firstName: first, lastName: 'K', status: 'ACTIVE', ...extra });
    const ray = await client('C-1', 'Raymond');
    const bea = await client('C-2', 'Bea');
    const gone = await client('C-3', 'Archived', { deletedAt: new Date() });
    const ended = await client('C-4', 'Ended');
    await M.ClientAssignment.create({ clientId: ray._id, staffProfileId: ada._id, role: 'BCBA', status: 'ACTIVE', weeklyAssignedHours: 6, effectiveStartDate: new Date('2026-03-01') });
    await M.ClientAssignment.create({ clientId: bea._id, staffProfileId: ada._id, role: 'BCBA', status: 'ACTIVE', weeklyAssignedHours: 4, effectiveStartDate: new Date('2026-04-01') });
    await M.ClientAssignment.create({ clientId: gone._id, staffProfileId: ada._id, role: 'BCBA', status: 'ACTIVE' });
    await M.ClientAssignment.create({ clientId: ended._id, staffProfileId: ada._id, role: 'BCBA', status: 'ENDED' });
    await M.ClientAssignment.create({ clientId: ray._id, staffProfileId: other._id, role: 'RBT', status: 'ACTIVE' });
    Object.assign(W, { ada: ada._id, other: other._id });
  });
  await withTenant(W.T2, async () => {
    const leak = await M.Client.create({ clientNumber: 'X-1', firstName: 'Leak', lastName: 'Client', status: 'ACTIVE' });
    await M.ClientAssignment.create({ clientId: leak._id, staffProfileId: W.ada, role: 'BCBA', status: 'ACTIVE' });
  });
});

after(async () => {
  if (skip) return;
  await mongoose?.disconnect();
  await server?.stop();
});

const ADMIN_VIEW = { dataScope: { scope: 'ORGANIZATION', staffIds: null, clientIds: null }, viewer: { canViewPay: true, canViewCaseload: true } };
const notFound = (p) => assert.rejects(p, (e) => { assert.equal(e.code, 'STAFF_NOT_FOUND'); assert.equal(e.status, 404); return true; });

test('Company Admin view: the requested staff member, account metadata, current pay rate and caseload', { skip }, async () => {
  const d = await staffService.getStaff({ tenantId: W.T, staffId: W.ada, ...ADMIN_VIEW });
  assert.equal(d.staff.id, W.ada);
  assert.deepEqual([d.staff.firstName, d.staff.middleName, d.staff.lastName, d.staff.title, d.staff.employeeNumber, d.staff.status, d.staff.startDate], ['Ada', 'King', 'Lovelace', 'Lead BCBA', 'EMP-0001', 'ACTIVE', '2026-02-01']);
  assert.equal(d.staff.loginEmail, 'ada.bcba@example.com');
  assert.deepEqual(d.staff.roleKeys, ['bcba']);
  assert.equal(d.staff.hourlyPayRate, 62.5, 'from the authoritative PayRate model');
  assert.equal(d.caseload.activeClientCount, 2);
  assert.deepEqual(d.caseload.assignments.map((a) => [a.clientName, a.role, a.weeklyAssignedHours, a.effectiveStartDate]), [
    ['Bea K', 'BCBA', 4, '2026-04-01'],
    ['Raymond K', 'BCBA', 6, '2026-03-01'],
  ]);
  const blob = JSON.stringify(d);
  assert.ok(!/hash-secret|passwordHash|resetToken|temporaryPassword|Leak Client|Archived K|Ended K/.test(blob));
});

test('pay rate is omitted entirely for a viewer without pay permission; caseload omitted unless allowed', { skip }, async () => {
  const d = await staffService.getStaff({ tenantId: W.T, staffId: W.ada, dataScope: ADMIN_VIEW.dataScope, viewer: { canViewPay: false, canViewCaseload: false } });
  assert.ok(!('hourlyPayRate' in d.staff));
  assert.equal(d.caseload, undefined);
});

test('narrowing scope: a staff member outside the caller’s staff.read scope is 404 (existence not disclosed)', { skip }, async () => {
  await notFound(staffService.getStaff({ tenantId: W.T, staffId: W.ada, dataScope: { scope: 'SELF', staffIds: [W.other], clientIds: [] } }));
  await notFound(staffService.getStaff({ tenantId: W.T, staffId: W.ada, dataScope: { scope: 'TEAM', staffIds: [], clientIds: [] } }));
  const own = await staffService.getStaff({ tenantId: W.T, staffId: W.other, dataScope: { scope: 'SELF', staffIds: [W.other], clientIds: [] }, viewer: { canViewPay: false } });
  assert.equal(own.staff.id, W.other);
});

test('tenant isolation: another tenant cannot read or update this staff member', { skip }, async () => {
  await notFound(staffService.getStaff({ tenantId: W.T2, staffId: W.ada, ...ADMIN_VIEW }));
  await notFound(staffService.updateStaff({ tenantId: W.T2, staffId: W.ada, actorUserId: 'x', expectedVersion: 0, input: { title: 'Hijack' } }));
});

test('existing update API: edits persist, optional fields can be cleared, version conflicts are refused', { skip }, async () => {
  const before = await staffService.getStaff({ tenantId: W.T, staffId: W.ada, ...ADMIN_VIEW });
  const input = updateStaffSchema.parse({ firstName: 'Ada', middleName: null, title: 'Clinical Director' });
  const updated = await staffService.updateStaff({ tenantId: W.T, staffId: W.ada, actorUserId: 'admin', expectedVersion: before.staff.version, input });
  assert.deepEqual([updated.middleName, updated.title], [null, 'Clinical Director']);
  assert.equal(updated.version, before.staff.version + 1);
  await assert.rejects(
    staffService.updateStaff({ tenantId: W.T, staffId: W.ada, actorUserId: 'admin', expectedVersion: before.staff.version, input: { title: 'Stale' } }),
    (e) => e.code === 'VERSION_CONFLICT',
  );
  const after = await staffService.getStaff({ tenantId: W.T, staffId: W.ada, ...ADMIN_VIEW });
  assert.deepEqual([after.staff.middleName, after.staff.title], [null, 'Clinical Director']);
});

test('status change through the update API is reversible and keeps the profile readable', { skip }, async () => {
  let d = await staffService.getStaff({ tenantId: W.T, staffId: W.ada, ...ADMIN_VIEW });
  await staffService.updateStaff({ tenantId: W.T, staffId: W.ada, actorUserId: 'admin', expectedVersion: d.staff.version, input: { status: 'INACTIVE' } });
  d = await staffService.getStaff({ tenantId: W.T, staffId: W.ada, ...ADMIN_VIEW });
  assert.equal(d.staff.status, 'INACTIVE');
  await staffService.updateStaff({ tenantId: W.T, staffId: W.ada, actorUserId: 'admin', expectedVersion: d.staff.version, input: { status: 'ACTIVE' } });
  d = await staffService.getStaff({ tenantId: W.T, staffId: W.ada, ...ADMIN_VIEW });
  assert.equal(d.staff.status, 'ACTIVE');
  const list = await staffService.listStaff({ tenantId: W.T, limit: 25 });
  assert.ok(list.items.some((s) => s.id === W.ada), 'still in the staff list');
});

test('update body is strict: tenant, employee number, role and unknown statuses are rejected', { skip }, () => {
  for (const bad of [{ tenantId: 't2' }, { employeeNumber: 'EMP-9' }, { roleKey: 'owner' }, { status: 'SUSPENDED' }, {}]) {
    assert.equal(updateStaffSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(updateStaffSchema.safeParse({ title: null, discipline: null }).success, true);
});
