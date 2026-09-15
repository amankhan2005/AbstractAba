import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientsService } from '../src/modules/clients/clients.service.js';

/**
 * Spec Module 2 — a client may only be ACTIVE when at least one VALID parent
 * (name + mobile + email) exists for that client+tenant. Enforced on the SERVER;
 * the browser-supplied status is never trusted. Removing/invalidating the last
 * valid parent demotes an ACTIVE client to ON_HOLD (a real, reversible status) —
 * never deletes it, never fabricates a status.
 */

const fakePhi = { seal: (v) => v, open: (v) => v };

function makeService({ state = 'ACTIVE', repo = {} } = {}) {
  const base = {
    createClient: async (_t, doc) => ({ id: 'c-1', firstName: doc.firstName, lastName: doc.lastName, status: doc.status ?? 'REFERRED', version: 1, sensitive: { ssn: null } }),
    findClientById: async () => ({ id: 'c-1', firstName: 'Ada', lastName: 'Lovelace', status: 'INTAKE', version: 1, sensitive: { ssn: null } }),
    updateClient: async (_t, _c, patch) => ({ id: 'c-1', firstName: 'Ada', lastName: 'Lovelace', status: patch.status ?? 'INTAKE', version: 2, sensitive: { ssn: null } }),
    listGuardians: async () => [],
    updateGuardian: async (_t, _c, gid, patch) => ({ id: gid, clientId: 'c-1', firstName: 'X', lastName: 'Y', ...patch }),
    removeGuardian: async () => {},
    ...repo,
  };
  return new ClientsService({ repository: base, organizations: { getById: async () => ({ state }) }, phi: fakePhi });
}

const VALID_PARENT = { id: 'g-1', firstName: 'John', lastName: 'Doe', phone: '+1 555 123 4567', email: 'john@doe.com' };
const PARTIAL_PARENT = { id: 'g-2', firstName: 'No', lastName: 'Email', phone: '+1 555 000 0000', email: '' };

// --- isValidParent -----------------------------------------------------------

test('isValidParent requires name + mobile + email', () => {
  assert.equal(ClientsService.isValidParent(VALID_PARENT), true);
  assert.equal(ClientsService.isValidParent(PARTIAL_PARENT), false);
  assert.equal(ClientsService.isValidParent({ firstName: 'A', lastName: 'B', email: 'a@b.com' }), false); // no phone
  assert.equal(ClientsService.isValidParent(null), false);
});

// --- create ------------------------------------------------------------------

test('creating a client directly as ACTIVE is refused (no parent can exist yet)', async () => {
  const svc = makeService();
  await assert.rejects(
    () => svc.createClient({ tenantId: 't', actorUserId: 'u', input: { firstName: 'Jane', lastName: 'Roe', status: 'ACTIVE' } }),
    (e) => e.code === 'CLIENT_ACTIVATION_REQUIRES_PARENT',
  );
});

test('creating a client without a status uses the default and succeeds', async () => {
  const svc = makeService();
  const out = await svc.createClient({ tenantId: 't', actorUserId: 'u', input: { firstName: 'Jane', lastName: 'Roe' } });
  assert.equal(out.status, 'REFERRED');
});

// --- update / activation -----------------------------------------------------

test('activating a client with NO valid parent is refused with a friendly message', async () => {
  const svc = makeService({ repo: { listGuardians: async () => [] } });
  await assert.rejects(
    () => svc.updateClient({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', expectedVersion: 1, input: { status: 'ACTIVE' } }),
    (e) => e.code === 'CLIENT_ACTIVATION_REQUIRES_PARENT' && /at least one parent/i.test(e.message),
  );
});

test('activating a client with only a PARTIAL parent is refused', async () => {
  const svc = makeService({ repo: { listGuardians: async () => [PARTIAL_PARENT] } });
  await assert.rejects(
    () => svc.updateClient({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', expectedVersion: 1, input: { status: 'ACTIVE' } }),
    (e) => e.code === 'CLIENT_ACTIVATION_REQUIRES_PARENT',
  );
});

test('activating a client WITH a valid parent succeeds', async () => {
  const svc = makeService({ repo: { listGuardians: async () => [VALID_PARENT] } });
  const out = await svc.updateClient({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', expectedVersion: 1, input: { status: 'ACTIVE' } });
  assert.equal(out.status, 'ACTIVE');
});

test('non-activation status changes are unaffected by the parent rule', async () => {
  const svc = makeService({ repo: { listGuardians: async () => [] } });
  const out = await svc.updateClient({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', expectedVersion: 1, input: { status: 'ON_HOLD' } });
  assert.equal(out.status, 'ON_HOLD');
});

// --- last-parent removal / invalidation invariant ----------------------------

test('removing the last valid parent demotes an ACTIVE client to ON_HOLD (never deletes)', async () => {
  let demotedTo = null;
  const svc = makeService({ repo: {
    findClientById: async () => ({ id: 'c-1', firstName: 'Ada', lastName: 'L', status: 'ACTIVE', version: 5, sensitive: { ssn: null } }),
    listGuardians: async () => [], // after removal, none remain
    updateClient: async (_t, _c, patch) => { demotedTo = patch.status; return { id: 'c-1', status: patch.status, version: 6, sensitive: { ssn: null } }; },
  } });
  await svc.removeGuardian({ tenantId: 't', clientId: 'c-1', guardianId: 'g-1', actorUserId: 'u' });
  assert.equal(demotedTo, 'ON_HOLD');
});

test('removing a parent while another VALID parent remains keeps the client ACTIVE', async () => {
  let statusChanged = false;
  const svc = makeService({ repo: {
    findClientById: async () => ({ id: 'c-1', firstName: 'Ada', lastName: 'L', status: 'ACTIVE', version: 5, sensitive: { ssn: null } }),
    listGuardians: async () => [VALID_PARENT], // one valid parent still present
    updateClient: async () => { statusChanged = true; return {}; },
  } });
  await svc.removeGuardian({ tenantId: 't', clientId: 'c-1', guardianId: 'g-2', actorUserId: 'u' });
  assert.equal(statusChanged, false, 'client must remain ACTIVE; no demotion write');
});

test('editing the last parent to be invalid demotes an ACTIVE client', async () => {
  let demotedTo = null;
  const svc = makeService({ repo: {
    findClientById: async () => ({ id: 'c-1', firstName: 'Ada', lastName: 'L', status: 'ACTIVE', version: 5, sensitive: { ssn: null } }),
    listGuardians: async () => [PARTIAL_PARENT], // email was cleared
    updateGuardian: async (_t, _c, gid, patch) => ({ id: gid, clientId: 'c-1', ...patch }),
    updateClient: async (_t, _c, patch) => { demotedTo = patch.status; return { id: 'c-1', status: patch.status, version: 6 }; },
  } });
  await svc.updateGuardian({ tenantId: 't', clientId: 'c-1', guardianId: 'g-2', actorUserId: 'u', input: { email: '' } });
  assert.equal(demotedTo, 'ON_HOLD');
});

test('a NON-active client that loses its parent is not touched (no spurious status write)', async () => {
  let statusChanged = false;
  const svc = makeService({ repo: {
    findClientById: async () => ({ id: 'c-1', firstName: 'Ada', lastName: 'L', status: 'INTAKE', version: 5, sensitive: { ssn: null } }),
    listGuardians: async () => [],
    updateClient: async () => { statusChanged = true; return {}; },
  } });
  await svc.removeGuardian({ tenantId: 't', clientId: 'c-1', guardianId: 'g-1', actorUserId: 'u' });
  assert.equal(statusChanged, false);
});

// --- Parent scoping / security (spec Module 2 Parts 22/24/25, Part 37) --------
// The repository enforces tenant + child scoping with withTenant + a
// findOne({ _id, clientId }) filter; a wrong child/tenant yields GUARDIAN_NOT_FOUND.
// These DB-free tests prove the SERVICE threads the exact clientId/tenant into the
// repository (so a caller cannot retarget another child) and propagates the
// not-found signal rather than silently succeeding.

test('updateGuardian passes the route clientId + tenant straight to the repository (no cross-child retarget)', async () => {
  const seen = {};
  const svc = makeService({ repo: {
    updateGuardian: async (t, c, gid, patch) => { Object.assign(seen, { t, c, gid, patch }); return { id: gid, clientId: c, firstName: 'X', lastName: 'Y', ...patch }; },
    listGuardians: async () => [VALID_PARENT],
    findClientById: async () => ({ id: 'c-1', status: 'INTAKE', version: 1 }),
  } });
  await svc.updateGuardian({ tenantId: 't-1', clientId: 'c-1', guardianId: 'g-1', actorUserId: 'u', input: { phone: '5551112222' } });
  assert.equal(seen.t, 't-1');
  assert.equal(seen.c, 'c-1', 'the clientId reaching the repo is the route clientId, so scoping applies');
  assert.equal(seen.gid, 'g-1');
});

test('a cross-child / cross-tenant guardian update surfaces GUARDIAN_NOT_FOUND (repo scoping rejects it)', async () => {
  const svc = makeService({ repo: {
    updateGuardian: async () => { const e = new Error('not found'); e.code = 'GUARDIAN_NOT_FOUND'; throw e; },
  } });
  await assert.rejects(
    () => svc.updateGuardian({ tenantId: 't-1', clientId: 'c-OTHER', guardianId: 'g-1', actorUserId: 'u', input: { phone: '5551112222' } }),
    (e) => e.code === 'GUARDIAN_NOT_FOUND',
  );
});

test('removeGuardian passes the route clientId to the repository so it cannot touch another child', async () => {
  const seen = {};
  const svc = makeService({ repo: {
    removeGuardian: async (t, c, gid) => { Object.assign(seen, { t, c, gid }); },
    listGuardians: async () => [],
    findClientById: async () => ({ id: 'c-1', status: 'INTAKE', version: 1 }),
  } });
  await svc.removeGuardian({ tenantId: 't-1', clientId: 'c-1', guardianId: 'g-9', actorUserId: 'u' });
  assert.equal(seen.t, 't-1');
  assert.equal(seen.c, 'c-1');
  assert.equal(seen.gid, 'g-9');
});

test('addGuardian requires the client to exist in THIS tenant (cross-tenant client rejected)', async () => {
  const svc = makeService({ repo: { findClientById: async () => null } });
  await assert.rejects(
    () => svc.addGuardian({ tenantId: 't-1', clientId: 'c-OTHER', actorUserId: 'u', input: { firstName: 'A', lastName: 'B', phone: '5551112222', email: 'a@b.com' } }),
    (e) => e.code === 'CLIENT_NOT_FOUND',
  );
});

// --- DOB timezone safety (spec Module 2 Part 5 / Module 14) -------------------
test('toDateOnly serializes a calendar date as timezone-safe YYYY-MM-DD (no UTC day shift)', async () => {
  const { toDateOnly } = await import('../src/modules/clients/clients.repository.js');
  // Stored at UTC midnight -> must serialize as exactly that calendar date.
  assert.equal(toDateOnly(new Date('2005-08-27T00:00:00.000Z')), '2005-08-27');
  // A full datetime is reduced to its UTC calendar date.
  assert.equal(toDateOnly(new Date('2015-01-01T05:30:00.000Z')), '2015-01-01');
  // Null / invalid -> null (UI shows "Not set", never "Invalid Date").
  assert.equal(toDateOnly(null), null);
  assert.equal(toDateOnly('not-a-date'), null);
});
