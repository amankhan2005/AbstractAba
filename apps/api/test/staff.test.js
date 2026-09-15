import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaffService } from '../src/modules/staff/staff.service.js';

/**
 * DB-free tests for the staff & credentials service against a fake repository
 * and fake ports. They lock in the ACTIVE gate, the supervision guards, and the
 * credential-expiry scan that raises the notification with no PHI.
 */

function makeService({ state = 'ACTIVE', repo = {}, dispatch, users } = {}) {
  const provisionCalls = [];
  const dispatched = [];
  const baseRepo = {
    nextEmployeeNumber: async () => 'EMP-00001',
    createStaff: async (_t, doc) => ({ id: 's-1', userId: doc.userId, firstName: doc.firstName, lastName: doc.lastName, status: doc.status ?? 'ACTIVE', title: null, discipline: null, employeeNumber: doc.employeeNumber ?? null, startDate: null, notes: null, createdAt: new Date(), version: 1 }),
    findStaffById: async (_t, id) => ({ id, userId: 'u-1', firstName: 'Ada', lastName: 'Lovelace', status: 'ACTIVE', title: null, discipline: 'BCBA', createdAt: new Date(), version: 1 }),
    listStaff: async () => ({ items: [{ id: 's-1', firstName: 'Ada', lastName: 'Lovelace', status: 'ACTIVE' }], nextCursor: null }),
    updateStaff: async (_t, id, patch) => ({ id, userId: 'u-1', firstName: patch.firstName ?? 'Ada', lastName: 'Lovelace', status: patch.status ?? 'ACTIVE', version: 2 }),
    deactivateStaff: async (_t, id) => ({ staffId: id, status: 'INACTIVE' }),
    listCredentials: async () => [],
    addCredential: async (_t, sid, input) => ({ id: 'cr-1', staffProfileId: sid, credentialType: input.credentialType, expiresDate: input.expiresDate ?? null, status: input.status ?? 'ACTIVE' }),
    updateCredential: async (_t, _s, cid, patch) => ({ id: cid, staffProfileId: 's-1', credentialType: patch.credentialType ?? 'BCBA', status: patch.status ?? 'ACTIVE' }),
    removeCredential: async () => {},
    listExpiringCredentials: async () => [],
    listSupervisees: async () => [],
    listSupervisors: async () => [],
    assignSupervisee: async (_t, sup, sub) => ({ id: 'sl-1', supervisorStaffId: sup, superviseeStaffId: sub, active: true }),
    endSupervision: async () => {},
    ...repo,
  };
  const enqueued = [];
  let idSeq = 0;
  const usersRepository = {
    provisionStaffAccount: async (args) => { provisionCalls.push(args); return { userId: args.userId, membershipId: args.membershipId }; },
    rotateStaffTempPassword: async () => {},
    findStaffAccountByUserId: async (_t, userId) => ({
      loginEmail: 'staff@example.com', userId, membershipId: 'mem-1', accountStatus: 'ACTIVE',
      membershipStatus: 'ACTIVE', roleKeys: ['rbt'], firstLoginCompleted: false, firstLoginAt: null, lastLoginAt: null,
    }),
    ...(users ?? {}),
  };
  const service = new StaffService({
    repository: baseRepo,
    organizations: { getById: async () => ({ state }) },
    notifications: { dispatch: dispatch ?? (async (type, ctx) => { dispatched.push({ type, ctx }); }) },
    usersRepository,
    passwords: { hash: async (p) => `hash(${p})`, generateTemporary: () => 'Temp0RaryPass' },
    jobQueue: { enqueue: async (job) => { enqueued.push(job); } },
    newId: () => { idSeq += 1; return `gen-${idSeq}`; },
    now: () => new Date('2026-08-05T00:00:00Z'),
  });
  return { service, dispatched, provisionCalls, enqueued };
}

// --- ACTIVE gate -----------------------------------------------------------

test('create staff is refused (409) when org is not ACTIVE', async () => {
  const { service } = makeService({ state: 'SUSPENDED' });
  await assert.rejects(
    () => service.createStaff({ tenantId: 't', actorUserId: 'u', input: { userId: 'u-9', firstName: 'A', lastName: 'B' } }),
    (e) => e.code === 'ORG_NOT_ACTIVE' && e.status === 409,
  );
});

test('every write path enforces the ACTIVE gate', async () => {
  const { service } = makeService({ state: 'PENDING_AGREEMENT' });
  const calls = [
    () => service.createStaff({ tenantId: 't', actorUserId: 'u', input: { userId: 'u-9', firstName: 'A', lastName: 'B' } }),
    () => service.updateStaff({ tenantId: 't', staffId: 's-1', actorUserId: 'u', expectedVersion: 1, input: { firstName: 'A' } }),
    () => service.deactivateStaff({ tenantId: 't', staffId: 's-1', actorUserId: 'u' }),
    () => service.addCredential({ tenantId: 't', staffId: 's-1', actorUserId: 'u', input: { credentialType: 'BCBA' } }),
    () => service.assignSupervisee({ tenantId: 't', staffId: 's-1', actorUserId: 'u', input: { superviseeStaffId: 's-2' } }),
  ];
  for (const call of calls) await assert.rejects(call, (e) => e.code === 'ORG_NOT_ACTIVE');
});

test('read paths do not require ACTIVE', async () => {
  const { service } = makeService({ state: 'SUSPENDED' });
  const page = await service.listStaff({ tenantId: 't', limit: 25 });
  assert.equal(page.items.length, 1);
  const detail = await service.getStaff({ tenantId: 't', staffId: 's-1' });
  assert.equal(detail.staff.id, 's-1');
});

// --- supervision guards ----------------------------------------------------

test('a staff member cannot supervise themselves', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.assignSupervisee({ tenantId: 't', staffId: 's-1', actorUserId: 'u', input: { superviseeStaffId: 's-1' } }),
    (e) => e.code === 'SELF_SUPERVISION' && e.status === 422,
  );
});

test('assigning a supervisee requires both staff to exist', async () => {
  const { service } = makeService({ repo: { findStaffById: async (_t, id) => (id === 's-1' ? { id, firstName: 'A', lastName: 'B' } : null) } });
  await assert.rejects(
    () => service.assignSupervisee({ tenantId: 't', staffId: 's-1', actorUserId: 'u', input: { superviseeStaffId: 'missing' } }),
    (e) => e.code === 'STAFF_NOT_FOUND',
  );
});

test('assignSupervisee delegates to the repository on success', async () => {
  const { service } = makeService();
  const link = await service.assignSupervisee({ tenantId: 't', staffId: 's-1', actorUserId: 'u', input: { superviseeStaffId: 's-2' } });
  assert.equal(link.supervisorStaffId, 's-1');
  assert.equal(link.superviseeStaffId, 's-2');
  assert.equal(link.active, true);
});

// --- detail orchestration --------------------------------------------------

test('getStaff assembles profile + credentials + supervisees + supervisors', async () => {
  const { service } = makeService({ repo: {
    listCredentials: async () => [{ id: 'cr-1', credentialType: 'BCBA', status: 'ACTIVE' }],
    listSupervisees: async () => [{ id: 'sl-1', supervisorStaffId: 's-1', superviseeStaffId: 's-2', active: true }],
    listSupervisors: async () => [],
  } });
  const detail = await service.getStaff({ tenantId: 't', staffId: 's-1' });
  assert.equal(detail.credentials.length, 1);
  assert.equal(detail.supervisees.length, 1);
  assert.equal(detail.supervisors.length, 0);
});

// --- credential-expiry scan (notification producer) ------------------------

test('scan raises one credential_expiring notification per expiring credential, PHI-free', async () => {
  const { service, dispatched } = makeService({ repo: {
    listExpiringCredentials: async () => [
      { id: 'cr-1', staffProfileId: 's-1', credentialType: 'RBT', expiresDate: new Date('2026-08-20T00:00:00Z'), status: 'ACTIVE' },
      { id: 'cr-2', staffProfileId: 's-2', credentialType: 'CPR', expiresDate: new Date('2026-08-25T00:00:00Z'), status: 'ACTIVE' },
    ],
    findStaffById: async (_t, id) => ({ id, firstName: 'Grace', lastName: 'Hopper' }),
  } });
  const result = await service.scanExpiringCredentials('t');
  assert.equal(result.scanned, 2);
  assert.equal(result.raised, 2);
  assert.equal(dispatched.length, 2);
  for (const d of dispatched) {
    assert.equal(d.type, 'staff.credential_expiring');
    assert.equal(d.ctx.tenantId, 't');
    assert.ok(d.ctx.content.subject.length > 0);
    assert.ok(d.ctx.content.link.startsWith('/staff'));
    // no patient/PHI concept exists in staff; assert the payload carries only
    // the expected content keys (subject/inAppBody/link) — nothing else.
    assert.deepEqual(Object.keys(d.ctx.content).sort(), ['inAppBody', 'link', 'subject']);
  }
});

test('scan raises nothing when no credentials are expiring', async () => {
  const { service, dispatched } = makeService({ repo: { listExpiringCredentials: async () => [] } });
  const result = await service.scanExpiringCredentials('t');
  assert.equal(result.scanned, 0);
  assert.equal(result.raised, 0);
  assert.equal(dispatched.length, 0);
});

// --- Add Staff provisioning (no manual userId) -----------------------------

test('provisionStaff creates the account server-side with a temp password and links the generated userId — no client userId, no temp password returned', async () => {
  const { service, provisionCalls, enqueued } = makeService();
  const out = await service.provisionStaff({ tenantId: 't', actorUserId: 'admin', input: {
    firstName: 'Mia', lastName: 'Reyes', email: 'Mia.Reyes@example.com', roleKey: 'rbt',
  } });
  // The account was provisioned with a HASHED temp password (never plaintext to the repo caller path),
  // the email normalized, the role pinned, the actor recorded.
  assert.equal(provisionCalls.length, 1);
  assert.equal(provisionCalls[0].tenantId, 't', 'membership is created in the admin\u2019s organization (server-derived tenant)');
  assert.equal(provisionCalls[0].email, 'mia.reyes@example.com');
  assert.equal(provisionCalls[0].roleKey, 'rbt');
  assert.equal(provisionCalls[0].actorUserId, 'admin');
  assert.equal(provisionCalls[0].fullName, 'Mia Reyes');
  assert.equal(provisionCalls[0].passwordHash, 'hash(Temp0RaryPass)');
  // The StaffProfile is linked to the GENERATED userId, never anything from the client.
  assert.equal(out.userId, 'gen-1');
  assert.equal(out.staff.userId, 'gen-1');
  // The temporary password is NEVER returned to the API caller/admin.
  assert.equal(out.temporaryPassword, undefined);
  assert.equal(out.staff.temporaryPassword, undefined);
  // The welcome email was enqueued AFTER creation, carrying the temp password only in the job payload.
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].type, 'staff.welcome_email.deliver');
  assert.equal(enqueued[0].payload.email, 'mia.reyes@example.com');
  assert.equal(enqueued[0].payload.temporaryPassword, 'Temp0RaryPass');
  assert.equal(out.emailQueued, true);
});

test('provisionStaff defaults discipline from the role when not supplied', async () => {
  const captured = [];
  const { service } = makeService({ repo: { createStaff: async (_t, doc) => { captured.push(doc); return { id: 's-9', ...doc }; } } });
  await service.provisionStaff({ tenantId: 't', actorUserId: 'admin', input: { firstName: 'B', lastName: 'C', email: 'b@example.com', roleKey: 'bcba' } });
  assert.equal(captured[0].discipline, 'BCBA');
  assert.equal(captured[0].userId, 'gen-1');
});

test('a duplicate email is rejected before any StaffProfile is written, and NO welcome email is sent (no orphan)', async () => {
  let created = 0;
  const { service, enqueued } = makeService({
    repo: { createStaff: async (_t, doc) => { created += 1; return { id: 's-1', ...doc }; } },
    users: { provisionStaffAccount: async () => { const e = new Error('duplicate'); e.code = 'DUPLICATE_STAFF_EMAIL'; throw e; } },
  });
  await assert.rejects(
    () => service.provisionStaff({ tenantId: 't', actorUserId: 'admin', input: { firstName: 'A', lastName: 'B', email: 'dupe@example.com', roleKey: 'rbt' } }),
    (e) => e.code === 'DUPLICATE_STAFF_EMAIL',
  );
  assert.equal(created, 0, 'no staff profile created when account provisioning fails');
  assert.equal(enqueued.length, 0, 'no welcome email enqueued when creation fails');
});

test('resendLoginEmail rotates the temp password and re-enqueues — only before first login', async () => {
  const rotated = [];
  const { service, enqueued } = makeService({
    repo: { findStaffById: async (_t, id) => ({ id, userId: 'u-1', firstName: 'Ada', lastName: 'Lovelace', discipline: 'RBT', status: 'ACTIVE' }) },
    users: {
      rotateStaffTempPassword: async (args) => { rotated.push(args); },
      findStaffAccountByUserId: async (_t, userId) => ({ loginEmail: 'ada@example.com', userId, membershipId: 'm-1', accountStatus: 'ACTIVE', membershipStatus: 'ACTIVE', roleKeys: ['rbt'], firstLoginCompleted: false, firstLoginAt: null, lastLoginAt: null }),
    },
  });
  const out = await service.resendLoginEmail({ tenantId: 't', staffId: 's-1', actorUserId: 'admin' });
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0].passwordHash, 'hash(Temp0RaryPass)');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].payload.email, 'ada@example.com');
  assert.equal(out.emailQueued, true);
});

test('resendLoginEmail is refused once first login is completed', async () => {
  const { service, enqueued } = makeService({
    users: { findStaffAccountByUserId: async (_t, userId) => ({ loginEmail: 'ada@example.com', userId, membershipId: 'm-1', accountStatus: 'ACTIVE', membershipStatus: 'ACTIVE', roleKeys: ['rbt'], firstLoginCompleted: true, firstLoginAt: new Date(), lastLoginAt: new Date() }) },
  });
  await assert.rejects(
    () => service.resendLoginEmail({ tenantId: 't', staffId: 's-1', actorUserId: 'admin' }),
    (e) => e.code === 'STAFF_ALREADY_ACTIVATED',
  );
  assert.equal(enqueued.length, 0);
});

test('getStaff surfaces SAFE account metadata (login email, first-login status) and NEVER secrets', async () => {
  const { service } = makeService();
  const detail = await service.getStaff({ tenantId: 't', staffId: 's-1' });
  assert.equal(detail.account.loginEmail, 'staff@example.com');
  assert.equal(detail.account.firstLoginCompleted, false);
  assert.equal(detail.staff.membershipId, 'mem-1');
  assert.equal(detail.staff.loginEmail, 'staff@example.com');
  const blob = JSON.stringify(detail);
  assert.ok(!/passwordHash|resetToken|tokenHash|temporaryPassword|passwordResetToken/i.test(blob), 'no secret fields in staff detail');
});

// --- spec Module 1: Hourly Pay Rate belongs to STAFF (PayRate), not care team --

function makeServiceWithPayRates({ payRates } = {}) {
  const rateCalls = [];
  const provisioned = [];
  const service = new StaffService({
    repository: {
      nextEmployeeNumber: async () => 'EMP-00001',
      createStaff: async (_t, doc) => ({ id: 'sp-1', userId: doc.userId, firstName: doc.firstName, lastName: doc.lastName, status: 'ACTIVE', discipline: doc.discipline ?? null, version: 1 }),
      findStaffById: async (_t, id) => ({ id, userId: 'u-1', firstName: 'Ada', lastName: 'Lovelace', status: 'ACTIVE', discipline: 'BCBA', version: 3 }),
      updateStaff: async (_t, id, patch) => ({ id, ...patch, version: 4 }),
      listCredentials: async () => [], listSupervisees: async () => [], listSupervisors: async () => [],
    },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    notifications: { dispatch: async () => {} },
    usersRepository: {
      provisionStaffAccount: async (args) => { provisioned.push(args); return { userId: args.userId, membershipId: args.membershipId }; },
      findStaffAccountByUserId: async (_t, userId) => ({ loginEmail: 'ada@x.com', userId, membershipId: 'm-1', accountStatus: 'ACTIVE', membershipStatus: 'ACTIVE', roleKeys: ['bcba'], firstLoginCompleted: false, firstLoginAt: null, lastLoginAt: null }),
    },
    passwords: { hash: async (p) => `hash(${p})`, generateTemporary: () => 'Temp0RaryPass' },
    jobQueue: { enqueue: async () => {} },
    payRates: payRates ?? {
      setHourlyRate: async (args) => { rateCalls.push(args); },
      getCurrentHourlyRate: async () => 25,
    },
    newId: (() => { let n = 0; return () => `id-${(n += 1)}`; })(),
    now: () => new Date('2026-08-05T00:00:00Z'),
  });
  return { service, rateCalls, provisioned };
}

test('Module 1: provisionStaff persists the Hourly Pay Rate to the staff PayRate port (dollars, effective-dated)', async () => {
  const { service, rateCalls } = makeServiceWithPayRates();
  await service.provisionStaff({ tenantId: 't', actorUserId: 'admin', input: {
    firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.com', roleKey: 'bcba', hourlyPayRate: 25, startDate: '2026-08-05',
  } });
  assert.equal(rateCalls.length, 1, 'exactly one rate write');
  assert.equal(rateCalls[0].staffProfileId, 'sp-1');
  assert.equal(rateCalls[0].amount, 25);
  assert.ok(rateCalls[0].effectiveFrom instanceof Date);
});

test('Module 1: provisionStaff without an Hourly Pay Rate does not write a rate', async () => {
  const { service, rateCalls } = makeServiceWithPayRates();
  await service.provisionStaff({ tenantId: 't', actorUserId: 'admin', input: {
    firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.com', roleKey: 'rbt',
  } });
  assert.equal(rateCalls.length, 0);
});

test('Module 1: updateStaff routes an Hourly Pay Rate change to the PayRate port, never onto the profile row', async () => {
  const captured = [];
  const { service, rateCalls } = makeServiceWithPayRates();
  // Wrap the repo.updateStaff to capture the profile patch it receives.
  const origUpdate = service.deps.repository.updateStaff;
  service.deps.repository.updateStaff = async (t, id, patch, v) => { captured.push(patch); return origUpdate(t, id, patch, v); };
  await service.updateStaff({ tenantId: 't', staffId: 'sp-1', actorUserId: 'admin', expectedVersion: 3, input: { hourlyPayRate: 30, firstName: 'Ada2' } });
  assert.equal(rateCalls.length, 1);
  assert.equal(rateCalls[0].amount, 30);
  assert.equal('hourlyPayRate' in captured[0], false, 'hourlyPayRate must NOT be written to the StaffProfile');
  assert.equal(captured[0].firstName, 'Ada2', 'ordinary profile fields still patch');
});

test('Module 1: getStaff surfaces the current Hourly Pay Rate from the authoritative PayRate source', async () => {
  const { service } = makeServiceWithPayRates();
  const detail = await service.getStaff({ tenantId: 't', staffId: 'sp-1' });
  assert.equal(detail.staff.hourlyPayRate, 25);
});
