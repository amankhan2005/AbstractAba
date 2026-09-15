import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

/**
 * ADD STAFF (POST /v1/staff) — against a REAL MongoDB, with exactly the body
 * the redesigned Add Staff form sends (no title, no status, no tenant/user id).
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

let server; let mongoose; let M; let withTenant; let withPlatform; let staffService; let provisionStaffSchema; let createStaffRouter;
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
  ({ provisionStaffSchema } = await import('../src/modules/staff/staff.schemas.js'));
  ({ createStaffRouter } = await import('../src/modules/staff/staff.routes.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
  const org = (slug) => M.Organization.create({ slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: 'America/New_York', primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` });
  W.T = (await org('create-acme'))._id;
  W.T2 = (await org('create-other'))._id;
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const FORM_BODY = { roleKey: 'rbt', firstName: 'Nia', middleName: 'Rose', lastName: 'Patel', email: 'Nia.Patel@Clinic.com', hourlyPayRate: 28.5 };

test('the form body passes the strict create schema; tenant, user, status, employee number are rejected', { skip }, () => {
  assert.equal(provisionStaffSchema.safeParse(FORM_BODY).success, true);
  for (const extra of [{ tenantId: W.T2 }, { userId: 'u' }, { status: 'INACTIVE' }, { employeeNumber: 'EMP-9' }]) {
    assert.equal(provisionStaffSchema.safeParse({ ...FORM_BODY, ...extra }).success, false, JSON.stringify(extra));
  }
  assert.equal(provisionStaffSchema.safeParse({ ...FORM_BODY, roleKey: 'owner' }).success, false);
});

test('creation without a title: ACTIVE profile in the caller’s tenant, role membership, employee ID, pay rate, normalized email', { skip }, async () => {
  const input = provisionStaffSchema.parse(FORM_BODY);
  const result = await staffService.provisionStaff({ tenantId: W.T, actorUserId: 'admin', input });
  W.created = result.staff;
  assert.equal(result.staff.status, 'ACTIVE');
  assert.equal(result.staff.title, null);
  assert.equal(result.staff.discipline, 'RBT');
  assert.match(result.staff.employeeNumber, /\S+/);
  assert.equal('temporaryPassword' in result, false);

  const user = await withPlatform(async () => await M.User.findById(result.userId).lean());
  assert.equal(user.email, 'nia.patel@clinic.com');
  const detail = await staffService.getStaff({ tenantId: W.T, staffId: result.staff.id, dataScope: { staffIds: null }, viewer: { canViewPay: true } });
  assert.deepEqual(detail.staff.roleKeys, ['rbt']);
  assert.equal(detail.staff.hourlyPayRate, 28.5);
  const membership = await withTenant(W.T, async () => await M.Membership.findById(result.membershipId).lean());
  assert.equal(membership.tenantId, W.T);
});

test('the new staff member appears in the Staff list for this tenant only', { skip }, async () => {
  const mine = await staffService.listStaff({ tenantId: W.T, limit: 25 });
  assert.ok(mine.items.some((s) => s.id === W.created.id && s.email === 'nia.patel@clinic.com'));
  const searched = await staffService.listStaff({ tenantId: W.T, limit: 25, search: 'Pat' });
  assert.deepEqual(searched.items.map((s) => s.id), [W.created.id]);
  const other = await staffService.listStaff({ tenantId: W.T2, limit: 25 });
  assert.equal(other.items.length, 0);
  await assert.rejects(staffService.getStaff({ tenantId: W.T2, staffId: W.created.id }), (e) => e.code === 'STAFF_NOT_FOUND');
});

test('duplicate email → 409 DUPLICATE_STAFF_EMAIL, and no second profile is written', { skip }, async () => {
  const before = await withTenant(W.T, async () => await M.StaffProfile.countDocuments({}));
  await assert.rejects(
    staffService.provisionStaff({ tenantId: W.T, actorUserId: 'admin', input: provisionStaffSchema.parse({ ...FORM_BODY, email: 'nia.patel@clinic.com', firstName: 'Other' }) }),
    (e) => e.code === 'DUPLICATE_STAFF_EMAIL' && e.status === 409,
  );
  assert.equal(await withTenant(W.T, async () => await M.StaffProfile.countDocuments({})), before);
});

test('route: POST /staff requires staff.manage and validates the body before the handler', { skip }, () => {
  const router = createStaffRouter({});
  const post = router.stack.find((l) => l.route?.path === '/' && l.route.methods.post);
  assert.ok(post);
  assert.ok(post.route.stack.length >= 3, 'permission guard + body validation + handler');
});
