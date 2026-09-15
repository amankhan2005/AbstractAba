import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientsService } from '../src/modules/clients/clients.service.js';
import { authorizationService } from '../src/modules/rbac/authorization.service.js';
import { isKnownPermission } from '../src/modules/rbac/permissionCatalogue.js';
import { requirePermission } from '../src/middleware/requirePermission.js';
import { createMedicalSchema, updateMedicalSchema } from '../src/modules/clients/clients.schemas.js';

/**
 * REGRESSION — GAP 1 (medical conditions + history) and GAP 2 (child-editor
 * lockout) are enforced on the SERVER.
 *
 *  - Company/Admin owns medical writes (clients.medical.manage); a BCBA/RBT
 *    reads (scoped + field-filtered) but cannot create/edit/delete.
 *  - The Company child editor (PATCH /clients/:id → clients.update) is Company-
 *    only; a BCBA/RBT direct call is rejected regardless of the UI.
 * All offline: capability resolution is pure, the middleware rejects before any
 * DB work, and the service runs against an in-memory fake repository.
 */

const MEDICAL_MANAGE = 'clients.medical.manage';
const can = (roleKeys, perm) => authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);
const runGuard = (mw, req) => new Promise((resolve) => mw(req, {}, (err) => resolve(err ?? null)));
function principalFor(roleKeys) {
  const resolved = authorizationService.resolvePermissions({ roleKeys, isPlatformOperator: false });
  return { userId: `u-${roleKeys.join('-')}`, roleKeys, permissions: new Set(resolved.keys()), permissionScopes: new Map(resolved.entries()) };
}

// --- in-memory service over a fake repo (mirrors the real medical methods) ---
function makeService() {
  const store = [];
  let seq = 0;
  const repo = {
    findClientById: async () => ({ id: 'c-1', clientNumber: 'CL-1', firstName: 'Aman', lastName: 'Khan', status: 'ACTIVE', version: 1, sensitive: { ssn: null } }),
    listGuardians: async () => [], listContacts: async () => [], findIntake: async () => null,
    listAssignments: async () => [], listServiceAuthorizations: async () => [],
    listMedicalEntries: async (_t, clientId, type) => store.filter((m) => m.clientId === clientId && (!type || m.type === type)),
    addMedicalEntry: async (_t, clientId, input) => { const e = { id: `m-${(seq += 1)}`, clientId, attachments: input.attachments ?? [], ...input }; store.push(e); return e; },
    updateMedicalEntry: async (_t, clientId, entryId, patch) => { const e = store.find((m) => m.id === entryId && m.clientId === clientId); Object.assign(e, patch); return e; },
    removeMedicalEntry: async (_t, clientId, entryId) => { const i = store.findIndex((m) => m.id === entryId && m.clientId === clientId); store.splice(i, 1); },
    // Only 'doc-ok' is a valid attachment for c-1; anything else is invalid.
    invalidAttachmentIds: async (_t, clientId, ids) => (ids ?? []).filter((id) => !(clientId === 'c-1' && id === '11111111-1111-4111-8111-111111111111')),
  };
  return { svc: new ClientsService({ repository: repo, organizations: { getById: async () => ({ state: 'ACTIVE' }) }, phi: { seal: (v) => v, open: (v) => v } }), store };
}

// ---- permission model ------------------------------------------------------

test('clients.medical.manage is catalogued and Company/Admin-only', () => {
  assert.equal(isKnownPermission(MEDICAL_MANAGE), true);
  for (const r of ['owner', 'org_admin']) assert.equal(can([r], MEDICAL_MANAGE), true, `${r} manages medical`);
  for (const r of ['bcba', 'rbt', 'scheduler', 'receptionist', 'billing_staff']) assert.equal(can([r], MEDICAL_MANAGE), false, `${r} must NOT`);
  // clinicians can still READ medical (via clients.read + getClient)
  assert.equal(can(['bcba'], 'clients.read'), true);
  assert.equal(can(['rbt'], 'clients.read'), true);
});

test('GAP 2 — the child editor (clients.update) is Company-only; BCBA/RBT rejected at the guard', async () => {
  assert.equal(can(['owner'], 'clients.update'), true);
  assert.equal(can(['org_admin'], 'clients.update'), true);
  assert.equal(can(['receptionist'], 'clients.update'), true); // front desk keeps intake/demographics
  assert.equal(can(['bcba'], 'clients.update'), false);
  assert.equal(can(['rbt'], 'clients.update'), false);
  const guard = requirePermission('clients.update');
  assert.equal((await runGuard(guard, { principal: principalFor(['bcba']) }))?.status, 403);
  assert.equal((await runGuard(guard, { principal: principalFor(['rbt']) }))?.status, 403);
});

test('medical mutation guard rejects BCBA and RBT (403 before any DB work)', async () => {
  const guard = requirePermission(MEDICAL_MANAGE);
  assert.equal((await runGuard(guard, { principal: principalFor(['bcba']) }))?.status, 403);
  assert.equal((await runGuard(guard, { principal: principalFor(['rbt']) }))?.status, 403);
});

// ---- service CRUD + persistence + association ------------------------------

test('Company medical: create/list/edit/delete conditions and history persist', async () => {
  const { svc } = makeService();
  const cond = await svc.addMedical({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', input: { type: 'CONDITION', label: 'ADHD', status: 'ACTIVE', provider: 'Dr. Reed' } });
  assert.equal(cond.type, 'CONDITION');
  assert.equal(cond.clientId, 'c-1'); // correct child association
  await svc.addMedical({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', input: { type: 'HISTORY', label: 'Seizure 2021', onsetDate: '2021-06-01' } });

  const all = await svc.listMedical({ tenantId: 't', clientId: 'c-1' });
  assert.equal(all.length, 2);
  const conditions = await svc.listMedical({ tenantId: 't', clientId: 'c-1', type: 'CONDITION' });
  assert.equal(conditions.length, 1);

  const edited = await svc.updateMedical({ tenantId: 't', clientId: 'c-1', entryId: cond.id, actorUserId: 'admin', input: { status: 'CHRONIC' } });
  assert.equal(edited.status, 'CHRONIC');

  await svc.removeMedical({ tenantId: 't', clientId: 'c-1', entryId: cond.id });
  assert.equal((await svc.listMedical({ tenantId: 't', clientId: 'c-1' })).length, 1);
});

test('getClient embeds medical; RBT gets conditions-only (no history, no provider/notes/dates)', async () => {
  const { svc } = makeService();
  await svc.addMedical({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', input: { type: 'CONDITION', label: 'ADHD', status: 'ACTIVE', provider: 'Dr. Reed', notes: 'secret', onsetDate: '2020-01-01' } });
  await svc.addMedical({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', input: { type: 'HISTORY', label: 'Seizure 2021', status: 'RESOLVED', onsetDate: '2021-06-01' } });

  const company = await svc.getClient({ tenantId: 't', clientId: 'c-1', viewer: { scope: 'ORGANIZATION', canSeeCompensation: true } });
  assert.equal(company.medical.length, 2);
  assert.equal(company.medical.find((m) => m.type === 'CONDITION').provider, 'Dr. Reed');

  const bcba = await svc.getClient({ tenantId: 't', clientId: 'c-1', viewer: { scope: 'TEAM', canSeeCompensation: false } });
  assert.equal(bcba.medical.length, 2); // clinician reads conditions AND history

  const rbt = await svc.getClient({ tenantId: 't', clientId: 'c-1', viewer: { scope: 'SELF', canSeeCompensation: false } });
  assert.equal(rbt.medical.length, 1); // history dropped entirely
  assert.equal(rbt.medical[0].type, 'CONDITION');
  assert.equal(rbt.medical[0].label, 'ADHD');
  assert.equal('provider' in rbt.medical[0], false);
  assert.equal('notes' in rbt.medical[0], false);
  assert.equal('onsetDate' in rbt.medical[0], false);
  assert.equal(rbt.medical.some((m) => m.type === 'HISTORY'), false);
});

// ---- schema validation -----------------------------------------------------

test('medical schemas validate type/fields and reject junk', () => {
  assert.equal(createMedicalSchema.safeParse({ type: 'CONDITION', label: 'ADHD' }).success, true);
  assert.equal(createMedicalSchema.safeParse({ type: 'HISTORY', label: 'Event', onsetDate: '2021-06-01', status: 'RESOLVED' }).success, true);
  assert.equal(createMedicalSchema.safeParse({ type: 'BOGUS', label: 'x' }).success, false);
  assert.equal(createMedicalSchema.safeParse({ label: 'no type' }).success, false);
  assert.equal(createMedicalSchema.safeParse({ type: 'CONDITION' }).success, false); // missing label
  assert.equal(updateMedicalSchema.safeParse({}).success, false); // needs at least one field
  assert.equal(updateMedicalSchema.safeParse({ status: 'MONITORING' }).success, true);
  assert.equal(createMedicalSchema.safeParse({ type: 'HISTORY', label: 'Report', attachmentDocumentIds: ['11111111-1111-4111-8111-111111111111'] }).success, true);
});

test('medical attachments: a valid document links and persists; a foreign document is rejected', async () => {
  const { svc } = makeService();
  // valid attachment (doc-ok belongs to c-1) links and persists
  const entry = await svc.addMedical({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', input: { type: 'HISTORY', label: 'Assessment', attachmentDocumentIds: ['11111111-1111-4111-8111-111111111111'] } });
  assert.deepEqual(entry.attachments, ['11111111-1111-4111-8111-111111111111']);
  const reloaded = await svc.listMedical({ tenantId: 't', clientId: 'c-1' });
  assert.deepEqual(reloaded[0].attachments, ['11111111-1111-4111-8111-111111111111']);
  // a document that isn't this child's (or doesn't exist) is rejected — no silent drop
  await assert.rejects(
    () => svc.addMedical({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', input: { type: 'HISTORY', label: 'Bad', attachmentDocumentIds: ['22222222-2222-4222-8222-222222222222'] } }),
    (e) => e.code === 'MEDICAL_ATTACHMENT_INVALID' || /attachment/i.test(e.message),
  );
});

test('RBT never receives medical attachments (history dropped entirely)', async () => {
  const { svc } = makeService();
  await svc.addMedical({ tenantId: 't', clientId: 'c-1', actorUserId: 'admin', input: { type: 'HISTORY', label: 'Report', attachmentDocumentIds: ['11111111-1111-4111-8111-111111111111'] } });
  const rbt = await svc.getClient({ tenantId: 't', clientId: 'c-1', viewer: { scope: 'SELF', canSeeCompensation: false } });
  assert.equal(rbt.medical.some((m) => m.type === 'HISTORY'), false);
  assert.equal(rbt.medical.some((m) => (m.attachments ?? []).length > 0), false);
});
