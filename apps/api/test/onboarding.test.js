import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnboardingService } from '../src/modules/onboarding/onboarding.service.js';
import { ProvisioningService, PROVISIONING_STEPS } from '../src/modules/onboarding/onboarding.provisioning.js';

/** DB-free tests for onboarding: provisioning idempotency/failure, the agreement
 *  gate, countersignature, the checklist, and the offboarding/destruction flow. */

// --- provisioning service --------------------------------------------------

function fakeProvRepo() {
  const steps = new Map(); // stepKey -> { state, attempts, detail }
  return {
    _steps: steps,
    upsertProvisioningStep: async ({ stepKey }) => { if (!steps.has(stepKey)) steps.set(stepKey, { stepKey, state: 'PENDING', attempts: 0, detail: null }); },
    listProvisioningSteps: async () => PROVISIONING_STEPS.filter((k) => steps.has(k)).map((k) => ({ ...steps.get(k) })),
    markProvisioningStep: async ({ stepKey, state, detail, incrementAttempts }) => {
      const s = steps.get(stepKey); s.state = state; s.detail = detail; if (incrementAttempts) s.attempts += 1;
    },
    recordProvisionedResources: async () => {},
    seedDefaultSettings: async () => 2,
    openMeteringLedger: async () => {},
  };
}

test('provisioning runs all steps and reports complete', async () => {
  const repo = fakeProvRepo();
  const svc = new ProvisioningService({ repository: repo, provisioner: { createEncryptionKey: async () => 'k', createStoragePrefix: async () => 'p' }, newId: () => 'id', defaultSettings: [] });
  const outcome = await svc.run('org-1');
  assert.equal(outcome.complete, true);
  assert.equal(outcome.failedStep, null);
  assert.ok(outcome.steps.every((s) => s.state === 'COMPLETED'));
});

test('provisioning is idempotent: completed steps are skipped, not repeated', async () => {
  const repo = fakeProvRepo();
  let keyCalls = 0;
  const provisioner = { createEncryptionKey: async () => { keyCalls += 1; return 'k'; }, createStoragePrefix: async () => 'p' };
  const svc = new ProvisioningService({ repository: repo, provisioner, newId: () => 'id', defaultSettings: [] });
  await svc.run('org-1');
  await svc.run('org-1'); // second run
  assert.equal(keyCalls, 1); // encryption key created once only
});

test('a failing step leaves provisioning incomplete and names the failed step', async () => {
  const repo = fakeProvRepo();
  const provisioner = { createEncryptionKey: async () => 'k', createStoragePrefix: async () => { throw new Error('storage down'); } };
  const svc = new ProvisioningService({ repository: repo, provisioner, newId: () => 'id', defaultSettings: [] });
  const outcome = await svc.run('org-1');
  assert.equal(outcome.complete, false);
  assert.equal(outcome.failedStep, 'storage_prefix');
  assert.equal(repo._steps.get('storage_prefix').state, 'FAILED');
  assert.equal(repo._steps.get('storage_prefix').detail, 'storage down');
  // metering_ledger (after the failure) never ran
  assert.equal(repo._steps.get('metering_ledger').state, 'PENDING');
});

// --- onboarding service ----------------------------------------------------

function makeService(over = {}) {
  const transitions = [];
  const deps = {
    newId: () => 'new-id',
    destructionGraceDays: 30,
    exportTtlHours: 72,
    provisioning: { run: async () => ({ complete: true, steps: [], failedStep: null }) },
    organizations: {
      getById: async () => ({ id: 'org-1', state: 'PROVISIONING', version: 1 }),
      transition: async (t) => { transitions.push(t); return { id: t.organizationId, state: t.toState, version: 2 }; },
    },
    repository: {
      createAgreement: async (a) => ({ ...a, countersignedAt: null, countersignedByUserId: null }),
      findAgreements: async () => [],
      countersignAgreement: async ({ agreementId, userId }) => ({ id: agreementId, type: 'BUSINESS_ASSOCIATE', countersignedAt: new Date(), countersignedByUserId: userId }),
      attachAgreementToOrganization: async () => {},
      listProvisioningSteps: async () => [],
      createExport: async (e) => ({ id: e.id, organizationId: e.organizationId, state: 'REQUESTED', requestedByUserId: e.requestedByUserId, requestedAt: new Date() }),
      updateExportState: async (i) => ({ id: i.exportId, state: i.state, availableAt: new Date(), expiresAt: i.expiresAt }),
      findLatestExport: async () => null,
      ...over.repository,
    },
    ...over,
  };
  const svc = new OnboardingService(deps);
  svc._transitions = transitions;
  return svc;
}

test('provision advances to PENDING_AGREEMENT only when every step completes', async () => {
  const svc = makeService();
  await svc.provision({ organizationId: 'org-1', actorUserId: 'op' });
  assert.equal(svc._transitions.length, 1);
  assert.equal(svc._transitions[0].toState, 'PENDING_AGREEMENT');

  const incomplete = makeService({ provisioning: { run: async () => ({ complete: false, steps: [], failedStep: 'storage_prefix' }) } });
  await incomplete.provision({ organizationId: 'org-1', actorUserId: 'op' });
  assert.equal(incomplete._transitions.length, 0); // no advance on incomplete
});

test('provision refuses an organization that is not PROVISIONING', async () => {
  const svc = makeService({ organizations: { getById: async () => ({ id: 'org-1', state: 'ACTIVE', version: 5 }), transition: async () => {} } });
  await assert.rejects(() => svc.provision({ organizationId: 'org-1', actorUserId: 'op' }), (e) => e.code === 'ILLEGAL_STATE_TRANSITION');
});

test('recordAgreement rejects a future execution date and a destroyed org', async () => {
  const future = makeService({ organizations: { getById: async () => ({ state: 'PENDING_AGREEMENT' }), transition: async () => {} } });
  await assert.rejects(
    () => future.recordAgreement({ organizationId: 'o', type: 'BUSINESS_ASSOCIATE', version: '1', executedByName: 'A B', executedByTitle: 'CEO', executedAt: new Date(Date.now() + 1e6), documentRef: null, actorUserId: 'op' }),
    (e) => e.code === 'VALIDATION_FAILED',
  );
  const destroyed = makeService({ organizations: { getById: async () => ({ state: 'DESTROYED' }), transition: async () => {} } });
  await assert.rejects(
    () => destroyed.recordAgreement({ organizationId: 'o', type: 'BUSINESS_ASSOCIATE', version: '1', executedByName: 'A B', executedByTitle: 'CEO', executedAt: new Date(Date.now() - 1000), documentRef: null, actorUserId: 'op' }),
    (e) => e.code === 'ILLEGAL_STATE_TRANSITION',
  );
});

test('countersign: not-found, already-countersigned conflict, and BAA attaches to org', async () => {
  const notFound = makeService({ repository: { findAgreements: async () => [] } });
  await assert.rejects(() => notFound.countersignAgreement({ organizationId: 'o', agreementId: 'x', actorUserId: 'op' }), (e) => e.code === 'NOT_FOUND');

  const already = makeService({ repository: { findAgreements: async () => [{ id: 'a1', type: 'BUSINESS_ASSOCIATE', countersignedAt: new Date() }] } });
  await assert.rejects(() => already.countersignAgreement({ organizationId: 'o', agreementId: 'a1', actorUserId: 'op' }), (e) => e.code === 'CONFLICT');

  let attached = false;
  const baa = makeService({ repository: {
    findAgreements: async () => [{ id: 'a1', type: 'BUSINESS_ASSOCIATE', countersignedAt: null }],
    countersignAgreement: async ({ agreementId, userId }) => ({ id: agreementId, type: 'BUSINESS_ASSOCIATE', countersignedAt: new Date(), countersignedByUserId: userId }),
    attachAgreementToOrganization: async () => { attached = true; },
  } });
  await baa.countersignAgreement({ organizationId: 'o', agreementId: 'a1', actorUserId: 'op' });
  assert.equal(attached, true);
});

test('checklist: readyToActivate requires PENDING_AGREEMENT + provisioning complete + countersigned BAA', async () => {
  const svc = makeService({
    organizations: { getById: async () => ({ id: 'o', state: 'PENDING_AGREEMENT', version: 2 }), transition: async () => {} },
    repository: {
      listProvisioningSteps: async () => PROVISIONING_STEPS.map((k) => ({ stepKey: k, state: 'COMPLETED', detail: null })),
      findAgreements: async () => [{ id: 'a1', type: 'BUSINESS_ASSOCIATE', countersignedAt: new Date() }],
    },
  });
  const c = await svc.checklist('o');
  assert.equal(c.readyToActivate, true);
  assert.equal(c.nextAction, 'Activate the organization');
});

test('beginOffboarding transitions to OFFBOARDING and creates an export', async () => {
  const svc = makeService({ organizations: { getById: async () => ({ state: 'ACTIVE' }), transition: async (t) => ({ id: t.organizationId, state: t.toState, version: 3 }) } });
  const result = await svc.beginOffboarding({ organizationId: 'o', actorUserId: 'op', expectedVersion: 2, reason: 'client left' });
  assert.equal(result.organization.state, 'OFFBOARDING');
  assert.equal(result.export.state, 'REQUESTED');
});

test('approveDestruction derives exportCompleted from the latest export and delegates to the state machine', async () => {
  const captured = [];
  const svc = makeService({
    organizations: { getById: async () => ({ state: 'OFFBOARDING' }), transition: async (t) => { captured.push(t); return { id: t.organizationId, state: t.toState, version: 9 }; } },
    repository: { findLatestExport: async () => ({ state: 'AVAILABLE' }) },
  });
  await svc.approveDestruction({ organizationId: 'o', requestedByUserId: 'req', approvedByUserId: 'app', expectedVersion: 8 });
  assert.equal(captured[0].toState, 'DESTROYED');
  assert.equal(captured[0].destruction.exportCompleted, true);
  assert.equal(captured[0].destruction.requestedByUserId, 'req');
  assert.equal(captured[0].actorUserId, 'app');
});
