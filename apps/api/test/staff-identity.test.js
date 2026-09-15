import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaffService } from '../src/modules/staff/staff.service.js';
import { provisionStaffSchema, updateStaffSchema } from '../src/modules/staff/staff.schemas.js';
import { AppError } from '../src/common/errors/AppError.js';

/**
 * Phase 1 §6/§7 — Employee ID is SERVER-generated (never client-supplied, never
 * regenerated on update, existing preserved) and staff email is editable by an
 * authorized admin on the canonical User row. DB-free, via fake ports.
 */
function makeService({ over = {} } = {}) {
  const created = [];
  const emailUpdates = [];
  const service = new StaffService({
    repository: {
      nextEmployeeNumber: async () => 'EMP-00007',
      createStaff: async (_t, doc) => { created.push(doc); return { id: 'sp-1', ...doc, version: 1 }; },
      findStaffById: async (_t, id) => ({ id, userId: 'u-1', firstName: 'Ada', lastName: 'Lovelace', employeeNumber: 'EMP-00007', version: 3 }),
      updateStaff: async (_t, id, patch) => ({ id, employeeNumber: 'EMP-00007', ...patch, version: 4 }),
      ...over.repository,
    },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    notifications: { dispatch: async () => {} },
    usersRepository: {
      provisionStaffAccount: async () => {},
      updateUserEmail: async (args) => { emailUpdates.push(args); return { ...args, changed: true }; },
      ...over.usersRepository,
    },
    passwords: { hash: async () => 'h', generateTemporary: () => 'tmp' },
    payRates: { setHourlyRate: async () => {} },
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    queue: { enqueue: async () => true },
  });
  return { service, created, emailUpdates };
}

// ---- schema guards --------------------------------------------------------
test('provision schema no longer accepts a client-supplied employeeNumber', () => {
  const r = provisionStaffSchema.safeParse({ firstName: 'A', lastName: 'B', email: 'a@b.com', roleKey: 'rbt', employeeNumber: 'HACK-1' });
  assert.equal(r.success, false); // strict schema rejects the unknown key
});
test('update schema does not accept employeeNumber but does accept email + middleName', () => {
  assert.equal(updateStaffSchema.safeParse({ employeeNumber: 'X' }).success, false);
  assert.equal(updateStaffSchema.safeParse({ email: 'new@b.com' }).success, true);
  assert.equal(updateStaffSchema.safeParse({ middleName: 'Marie' }).success, true);
});

// ---- employee id generation ----------------------------------------------
test('createStaff auto-generates the Employee ID from the server (not the client)', async () => {
  const { service, created } = makeService();
  const staff = await service.createStaff({ tenantId: 't', actorUserId: 'u', input: { userId: 'u-1', firstName: 'Ada', lastName: 'Lovelace' } });
  assert.equal(created[0].employeeNumber, 'EMP-00007');
  assert.equal(staff.employeeNumber, 'EMP-00007');
});
test('updating a staff member never regenerates or changes the Employee ID', async () => {
  const { service } = makeService();
  const updated = await service.updateStaff({ tenantId: 't', staffId: 'sp-1', actorUserId: 'u', input: { firstName: 'Ada B' } });
  // update patch carries no employeeNumber; the persisted value is untouched.
  assert.equal(updated.employeeNumber, 'EMP-00007');
});
test('a pre-existing/migrated employeeNumber is preserved (not overwritten)', async () => {
  const { service, created } = makeService();
  await service.createStaff({ tenantId: 't', actorUserId: 'u', input: { userId: 'u-1', firstName: 'A', lastName: 'B', employeeNumber: 'LEGACY-42' } });
  assert.equal(created[0].employeeNumber, 'LEGACY-42');
});

// ---- staff email CRUD -----------------------------------------------------
test('updateStaff routes an email change to the canonical User row', async () => {
  const { service, emailUpdates } = makeService();
  await service.updateStaff({ tenantId: 't', staffId: 'sp-1', actorUserId: 'admin', input: { email: 'New@B.com ' } });
  assert.equal(emailUpdates.length, 1);
  assert.equal(emailUpdates[0].userId, 'u-1');
  assert.equal(emailUpdates[0].email, 'new@b.com'); // normalized lower/trim
});
test('a duplicate email from the User layer surfaces as an error (no silent success)', async () => {
  const { service } = makeService({ over: { usersRepository: { updateUserEmail: async () => { throw AppError.conflict('USER-409', 'That email address is already in use.'); } } } });
  await assert.rejects(() => service.updateStaff({ tenantId: 't', staffId: 'sp-1', actorUserId: 'admin', input: { email: 'taken@b.com' } }));
});
