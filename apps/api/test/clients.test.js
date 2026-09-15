import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientsService } from '../src/modules/clients/clients.service.js';

/**
 * DB-free tests for the clients service, exercised against a fake repository and
 * fake collaborators. They lock in the module's guarantees: the ACTIVE gate,
 * PHI sealing before persistence and opening only on detail reads, and correct
 * orchestration of guardians / contacts / intake.
 */

// A reversible fake seam so tests can assert that PHI is sealed (not plaintext)
// on the way to the repository and opened on the way back.
const fakePhi = {
  seal: (v) => (v === null || v === undefined ? v : `SEALED(${v})`),
  open: (v) => (v === null || v === undefined ? v : String(v).replace(/^SEALED\((.*)\)$/, '$1')),
};

function makeService({ state = 'ACTIVE', repo = {} } = {}) {
  const baseRepo = {
    createClient: async (_t, doc) => ({ id: 'c-1', clientNumber: 'CL-ABCD1234', firstName: doc.firstName, lastName: doc.lastName, status: doc.status ?? 'REFERRED', dateOfBirth: doc.dateOfBirth ?? null, primaryGuardianId: null, createdAt: new Date(), version: 1, email: doc.email ?? null, phone: doc.phone ?? null, address: doc.address ?? null, sensitive: doc.sensitive ?? { ssn: null } }),
    findClientById: async () => ({ id: 'c-1', clientNumber: 'CL-ABCD1234', firstName: 'Ada', lastName: 'Lovelace', status: 'ACTIVE', dateOfBirth: null, primaryGuardianId: null, createdAt: new Date(), version: 1, sensitive: { ssn: 'SEALED(111-11-1111)' } }),
    listClients: async () => ({ items: [{ id: 'c-1', clientNumber: 'CL-ABCD1234', firstName: 'Ada', lastName: 'Lovelace', status: 'ACTIVE' }], nextCursor: null }),
    updateClient: async (_t, _c, patch) => ({ id: 'c-1', clientNumber: 'CL-ABCD1234', firstName: patch.firstName ?? 'Ada', lastName: 'Lovelace', status: 'ACTIVE', version: 2, sensitive: { ssn: patch['sensitive.ssn'] ?? null } }),
    archiveClient: async () => ({ clientId: 'c-1', status: 'ARCHIVED' }),
    listGuardians: async () => [],
    listContacts: async () => [],
    findIntake: async () => null,
    // in-memory FBA/ABA authorizations for Phase 2 tests
    __authStore: undefined,
    listServiceAuthorizations: async (_t, _c) => [],
    findServiceAuthorization: async () => null,
    findServiceAuthorizationByNumber: async () => null,
    findServiceAuthorizationById: async () => null,
    createServiceAuthorization: async (_t, doc) => ({ id: 'auth-1', ...doc, version: 1 }),
    updateServiceAuthorization: async (_t, _id, patch, hist) => ({ id: 'auth-1', clientId: 'c-1', serviceType: 'FBA', status: patch.status ?? 'NOT_SENT', history: hist ? [hist] : [], version: 2, ...patch }),
    listAssignments: async () => [],
    listMedicalEntries: async () => [],
    addGuardian: async (_t, _c, input) => ({ id: 'g-1', clientId: 'c-1', firstName: input.firstName, lastName: input.lastName, relationship: input.relationship ?? 'PARENT', isPrimary: !!input.isPrimary }),
    updateGuardian: async (_t, _c, gid, patch) => ({ id: gid, clientId: 'c-1', firstName: 'X', lastName: 'Y', isPrimary: patch.isPrimary ?? false }),
    removeGuardian: async () => {},
    addContact: async (_t, _c, input) => ({ id: 'k-1', clientId: 'c-1', name: input.name, contactType: input.contactType ?? 'OTHER' }),
    updateContact: async () => ({ id: 'k-1', clientId: 'c-1', name: 'Z', contactType: 'OTHER' }),
    removeContact: async () => {},
    upsertIntake: async (_t, _c, patch) => ({ id: 'i-1', clientId: 'c-1', status: patch.status ?? 'DRAFT', insurance: { payerName: patch['insurance.payerName'] ?? null, planName: null, memberId: patch['insurance.memberId'] ?? null }, consents: { hipaaAcknowledged: false, treatmentConsent: false, consentedAt: null } }),
    ...repo,
  };
  return new ClientsService({
    repository: baseRepo,
    organizations: { getById: async () => ({ state }) },
    phi: fakePhi,
  });
}

// --- ACTIVE gate -----------------------------------------------------------

test('create is refused (409) when the organization is not ACTIVE', async () => {
  const svc = makeService({ state: 'PENDING_AGREEMENT' });
  await assert.rejects(
    () => svc.createClient({ tenantId: 't-1', actorUserId: 'u-1', input: { firstName: 'Ada', lastName: 'Lovelace' } }),
    (e) => e.code === 'ORG_NOT_ACTIVE' && e.status === 409,
  );
});

test('every write path enforces the ACTIVE gate', async () => {
  const svc = makeService({ state: 'SUSPENDED' });
  const calls = [
    () => svc.createClient({ tenantId: 't', actorUserId: 'u', input: { firstName: 'A', lastName: 'B' } }),
    () => svc.updateClient({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', expectedVersion: 1, input: { firstName: 'A' } }),
    () => svc.archiveClient({ tenantId: 't', clientId: 'c-1', actorUserId: 'u' }),
    () => svc.addGuardian({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { firstName: 'G', lastName: 'H' } }),
    () => svc.addContact({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { name: 'C' } }),
    () => svc.upsertIntake({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { status: 'DRAFT' } }),
  ];
  for (const call of calls) {
    await assert.rejects(call, (e) => e.code === 'ORG_NOT_ACTIVE');
  }
});

test('read paths do NOT require ACTIVE (records remain viewable)', async () => {
  const svc = makeService({ state: 'SUSPENDED' });
  const detail = await svc.getClient({ tenantId: 't', clientId: 'c-1' });
  assert.equal(detail.client.id, 'c-1');
  const page = await svc.listClients({ tenantId: 't', limit: 25 });
  assert.equal(page.items.length, 1);
});

// --- PHI sealing / opening --------------------------------------------------

test('SSN is sealed before it reaches the repository', async () => {
  let seen = null;
  const svc = makeService({ repo: { createClient: async (_t, doc) => { seen = doc; return { id: 'c-1', clientNumber: 'CL-X', firstName: doc.firstName, lastName: doc.lastName, status: 'REFERRED', createdAt: new Date(), version: 1, sensitive: doc.sensitive }; } } });
  const out = await svc.createClient({ tenantId: 't', actorUserId: 'u', input: { firstName: 'Ada', lastName: 'Lovelace', ssn: '111-11-1111' } });
  assert.equal(seen.sensitive.ssn, 'SEALED(111-11-1111)', 'repository must receive sealed ciphertext, never plaintext');
  assert.notEqual(seen.sensitive.ssn, '111-11-1111');
  assert.equal(out.ssn, '111-11-1111', 'detail response opens the sealed value for the authorised caller');
});

test('list responses never carry the sealed envelope', async () => {
  const svc = makeService();
  const page = await svc.listClients({ tenantId: 't', limit: 25 });
  for (const item of page.items) {
    assert.equal(item.sensitive, undefined);
    assert.equal(item.ssn, undefined);
  }
});

test('detail opens the sealed SSN', async () => {
  const svc = makeService();
  const detail = await svc.getClient({ tenantId: 't', clientId: 'c-1' });
  assert.equal(detail.client.ssn, '111-11-1111');
  assert.equal(detail.client.sensitive, undefined, 'the raw sealed envelope is not exposed');
});

test('intake seals the insurance member id and opens it on return', async () => {
  let seen = null;
  const svc = makeService({ repo: { upsertIntake: async (_t, _c, patch) => { seen = patch; return { id: 'i-1', clientId: 'c-1', status: 'DRAFT', insurance: { payerName: null, planName: null, memberId: patch['insurance.memberId'] }, consents: {} }; } } });
  const out = await svc.upsertIntake({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { insurance: { memberId: 'M-9000' } } });
  assert.equal(seen['insurance.memberId'], 'SEALED(M-9000)');
  assert.equal(out.insurance.memberId, 'M-9000');
});

// --- orchestration ----------------------------------------------------------

test('getClient assembles client + guardians + contacts + intake', async () => {
  const svc = makeService({ repo: {
    listGuardians: async () => [{ id: 'g-1', clientId: 'c-1', firstName: 'G', lastName: 'H', isPrimary: true }],
    listContacts: async () => [{ id: 'k-1', clientId: 'c-1', name: 'Doc', contactType: 'PHYSICIAN' }],
    findIntake: async () => ({ id: 'i-1', clientId: 'c-1', status: 'COMPLETE', insurance: { payerName: 'Acme', planName: 'Gold', memberId: 'SEALED(M-1)' }, consents: {} }),
    listAssignments: async () => [],
    listMedicalEntries: async () => [],
  } });
  const detail = await svc.getClient({ tenantId: 't', clientId: 'c-1' });
  assert.equal(detail.guardians.length, 1);
  assert.equal(detail.contacts.length, 1);
  assert.equal(detail.intake.status, 'COMPLETE');
  assert.equal(detail.intake.insurance.memberId, 'M-1', 'intake member id is opened in detail');
});

test('adding a guardian first requires the client to exist', async () => {
  const svc = makeService({ repo: { findClientById: async () => null } });
  await assert.rejects(
    () => svc.addGuardian({ tenantId: 't', clientId: 'missing', actorUserId: 'u', input: { firstName: 'G', lastName: 'H' } }),
    (e) => e.code === 'CLIENT_NOT_FOUND' && e.status === 404,
  );
});

test('updateClient forwards the expected version for optimistic concurrency', async () => {
  let seenVersion = null;
  const svc = makeService({ repo: { updateClient: async (_t, _c, _p, v) => { seenVersion = v; return { id: 'c-1', clientNumber: 'CL-X', firstName: 'Ada', lastName: 'Lovelace', status: 'ACTIVE', version: 3, sensitive: { ssn: null } }; } } });
  await svc.updateClient({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', expectedVersion: 2, input: { firstName: 'Ada' } });
  assert.equal(seenVersion, 2);
});

// --- intake pipeline state machine (BR-INTAKE-1) ---------------------------

test('intake transition: valid step NOT_SENT -> SENT persists', async () => {
  let seen = null;
  const svc = makeService({ repo: {
    findClientById: async () => ({ id: 'c-1', clientNumber: 'CL-X', firstName: 'Ada', lastName: 'L', status: 'ACTIVE', intakeWorkflowStatus: 'NOT_SENT', version: 3, sensitive: { ssn: null } }),
    updateClient: async (_t, _c, patch) => { seen = patch; return { id: 'c-1', clientNumber: 'CL-X', firstName: 'Ada', lastName: 'L', status: 'ACTIVE', intakeWorkflowStatus: patch.intakeWorkflowStatus, version: 4, sensitive: { ssn: null } }; },
  } });
  const out = await svc.transitionIntakeWorkflow({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', target: 'SENT', expectedVersion: 3 });
  assert.equal(seen.intakeWorkflowStatus, 'SENT');
  assert.equal(out.intakeWorkflowStatus, 'SENT');
});

test('intake transition: invalid jump NOT_SENT -> COMPLETE is rejected (422), never persisted', async () => {
  let wrote = false;
  const svc = makeService({ repo: {
    findClientById: async () => ({ id: 'c-1', clientNumber: 'CL-X', firstName: 'Ada', lastName: 'L', status: 'ACTIVE', intakeWorkflowStatus: 'NOT_SENT', version: 1, sensitive: { ssn: null } }),
    updateClient: async () => { wrote = true; return {}; },
  } });
  await assert.rejects(
    () => svc.transitionIntakeWorkflow({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', target: 'COMPLETE', expectedVersion: 1 }),
    (err) => err.code === 'INTAKE_TRANSITION_INVALID',
  );
  assert.equal(wrote, false, 'an invalid transition must not write');
});

test('intake transition: RECEIVED -> COMPLETE allowed; SENT -> COMPLETE not', async () => {
  const at = (state) => makeService({ repo: {
    findClientById: async () => ({ id: 'c-1', clientNumber: 'CL-X', firstName: 'A', lastName: 'B', status: 'ACTIVE', intakeWorkflowStatus: state, version: 1, sensitive: { ssn: null } }),
    updateClient: async (_t, _c, patch) => ({ id: 'c-1', clientNumber: 'CL-X', firstName: 'A', lastName: 'B', status: 'ACTIVE', intakeWorkflowStatus: patch.intakeWorkflowStatus, version: 2, sensitive: { ssn: null } }),
  } });
  const ok = await at('RECEIVED').transitionIntakeWorkflow({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', target: 'COMPLETE', expectedVersion: 1 });
  assert.equal(ok.intakeWorkflowStatus, 'COMPLETE');
  await assert.rejects(() => at('SENT').transitionIntakeWorkflow({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', target: 'COMPLETE', expectedVersion: 1 }),
    (err) => err.code === 'INTAKE_TRANSITION_INVALID');
});

test('approvedWeeklyHours flows through updateClient patch', async () => {
  let seen = null;
  const svc = makeService({ repo: { updateClient: async (_t, _c, patch) => { seen = patch; return { id: 'c-1', clientNumber: 'CL-X', firstName: 'Ada', lastName: 'L', status: 'ACTIVE', approvedWeeklyHours: patch.approvedWeeklyHours, version: 2, sensitive: { ssn: null } }; } } });
  const out = await svc.updateClient({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', expectedVersion: 1, input: { approvedWeeklyHours: 20 } });
  assert.equal(seen.approvedWeeklyHours, 20);
  assert.equal(out.approvedWeeklyHours, 20);
});

// --- FBA/ABA service authorizations (Phase 2) ------------------------------

test('create FBA authorization starts NOT_SENT and rejects end<start', async () => {
  const svc = makeService({ repo: { listGuardians: async () => [{ id: 'g-1', firstName: 'Jane', lastName: 'Parent', phone: '5551234567', email: 'jane@example.com' }], } });
  const created = await svc.createServiceAuthorization({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { serviceType: 'FBA', authorizationNumber: 'A-1' } });
  assert.equal(created.status, 'NOT_SENT');
  assert.equal(created.serviceType, 'FBA');
  await assert.rejects(
    () => svc.createServiceAuthorization({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { serviceType: 'ABA', startDate: '2026-09-30', endDate: '2026-09-01' } }),
    (e) => e.code === 'AUTHORIZATION_DATES_INVALID',
  );
});

test('valid transition NOT_SENT->SENT->APPROVED writes history; invalid NOT_SENT->APPROVED is rejected with no write', async () => {
  let wrote = false;
  const at = (status) => makeService({ repo: {
    findServiceAuthorizationById: async () => ({ id: 'auth-1', clientId: 'c-1', serviceType: 'FBA', status, history: [], version: 1 }),
    updateServiceAuthorization: async (_t, _id, patch, hist) => { wrote = true; return { id: 'auth-1', clientId: 'c-1', serviceType: 'FBA', status: patch.status, history: hist ? [hist] : [], version: 2 }; },
  } });
  const sent = await at('NOT_SENT').transitionServiceAuthorization({ tenantId: 't', clientId: 'c-1', authorizationId: 'auth-1', actorUserId: 'u', target: 'SENT' });
  assert.equal(sent.status, 'SENT');
  assert.equal(sent.history.length, 1);
  assert.equal(sent.history[0].from, 'NOT_SENT');
  assert.equal(sent.history[0].to, 'SENT');

  wrote = false;
  await assert.rejects(
    () => at('NOT_SENT').transitionServiceAuthorization({ tenantId: 't', clientId: 'c-1', authorizationId: 'auth-1', actorUserId: 'u', target: 'APPROVED' }),
    (e) => e.code === 'AUTHORIZATION_TRANSITION_INVALID',
  );
  assert.equal(wrote, false, 'invalid transition must not write / must not create history');
});

test('deny requires a reason', async () => {
  const svc = makeService({ repo: { findServiceAuthorizationById: async () => ({ id: 'auth-1', clientId: 'c-1', serviceType: 'FBA', status: 'SENT', history: [], version: 1 }) } });
  await assert.rejects(
    () => svc.transitionServiceAuthorization({ tenantId: 't', clientId: 'c-1', authorizationId: 'auth-1', actorUserId: 'u', target: 'DENIED' }),
    (e) => e.code === 'AUTHORIZATION_DENY_REASON_REQUIRED',
  );
  const denied = await svc.transitionServiceAuthorization({ tenantId: 't', clientId: 'c-1', authorizationId: 'auth-1', actorUserId: 'u', target: 'DENIED', reason: 'Insufficient documentation' });
  assert.equal(denied.status, 'DENIED');
});

test('FBA and ABA are independent — approving FBA never touches the ABA record', async () => {
  const store = {
    FBA: { id: 'auth-fba', clientId: 'c-1', serviceType: 'FBA', status: 'SENT', history: [], version: 1 },
    ABA: { id: 'auth-aba', clientId: 'c-1', serviceType: 'ABA', status: 'NOT_SENT', history: [], version: 1 },
  };
  const svc = makeService({ repo: {
    findServiceAuthorizationById: async (_t, id) => (id === 'auth-fba' ? store.FBA : store.ABA),
    updateServiceAuthorization: async (_t, id, patch, hist) => {
      const rec = id === 'auth-fba' ? store.FBA : store.ABA;
      rec.status = patch.status; if (hist) rec.history.push(hist);
      return { ...rec };
    },
  } });
  await svc.transitionServiceAuthorization({ tenantId: 't', clientId: 'c-1', authorizationId: 'auth-fba', actorUserId: 'u', target: 'APPROVED' });
  assert.equal(store.FBA.status, 'APPROVED');
  assert.equal(store.ABA.status, 'NOT_SENT', 'ABA must be untouched by an FBA approval');
});

test('a new authorization requires a valid parent/guardian first (PARENT_DETAILS_REQUIRED, nothing written)', async () => {
  let wrote = false;
  const createServiceAuthorization = async (_t, doc) => { wrote = true; return { id: 'auth-1', ...doc }; };
  for (const guardians of [[], [{ id: 'g-1', firstName: 'Half', lastName: 'Parent', phone: '5550000000' }]]) {
    const svc = makeService({ repo: { listGuardians: async () => guardians, createServiceAuthorization } });
    await assert.rejects(
      () => svc.createServiceAuthorization({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { serviceType: 'ABA' } }),
      (e) => e.code === 'PARENT_DETAILS_REQUIRED' && e.status === 422 && e.message === 'Please add the parent or guardian details before continuing.',
    );
  }
  assert.equal(wrote, false);
  const ok = makeService({ repo: { listGuardians: async () => [{ id: 'g-1', firstName: 'Jane', lastName: 'Parent', phone: '5551234567', email: 'jane@example.com' }], createServiceAuthorization } });
  await ok.createServiceAuthorization({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { serviceType: 'ABA' } });
  assert.equal(wrote, true);
});

test('isAuthorizationActiveOn: usable as soon as saved (any status but DENIED), within the date window', async () => {
  const { ClientsService } = await import('../src/modules/clients/clients.service.js');
  const win = { startDate: '2026-09-01', endDate: '2026-09-30' };
  for (const status of ['NOT_SENT', 'SENT', 'APPROVED']) {
    assert.equal(ClientsService.isAuthorizationActiveOn({ status, ...win }, '2026-09-15'), true, status);
    assert.equal(ClientsService.isAuthorizationActiveOn({ status, ...win }, '2026-10-02'), false, status);
  }
  assert.equal(ClientsService.isAuthorizationActiveOn({ status: 'DENIED', ...win }, '2026-09-15'), false);
  assert.equal(ClientsService.isAuthorizationActiveOn({ status: 'NOT_SENT', deletedAt: new Date(), ...win }, '2026-09-15'), false);
});
