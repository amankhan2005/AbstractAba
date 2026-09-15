import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

/**
 * ADD = SAVE (FBA / ABA / Insurance) and EDIT CLIENT persistence — against a REAL MongoDB.
 *
 * Adding an authorization or insurance persists it immediately through the
 * existing create endpoint; no "Mark sent" / "Approve" (or verification) call is
 * needed for the record to exist, be listed after a reload, or count as saved in
 * the child alerts. A new authorization is usable immediately (its payer
 * NOT_SENT → SENT → APPROVED tracking is separate and never blocks use), and a
 * saved insurance record is VERIFIED automatically — no manual verification step.
 */
const CANDIDATES = [process.env.MONGOMS_SYSTEM_BINARY, '/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/usr/bin/mongod'].filter(Boolean);
const MONGOD = CANDIDATES.find((p) => existsSync(p)) ?? null;
const skip = MONGOD ? false : 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

let server; let mongoose; let M; let withTenant; let clientsService; let insuranceService; let createClientsRouter; let SYSTEM_ROLE_TEMPLATES;
const W = {};
const ACTOR = '00000000-0000-4000-8000-000000000001';

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
  ({ createClientsRouter } = await import('../src/modules/clients/clients.routes.js'));
  ({ SYSTEM_ROLE_TEMPLATES } = await import('../src/modules/rbac/roleTemplates.js'));
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
  const org = (slug) => M.Organization.create({ slug, legalName: slug, tradingName: slug, state: 'ACTIVE', countryCode: 'US', timezone: 'America/New_York', primaryContactName: 'O', primaryContactEmail: `${slug}@example.com` });
  W.T = (await org('save-acme'))._id;
  W.T2 = (await org('save-other'))._id;
  await withTenant(W.T, async () => {
    const c = await M.Client.create({ clientNumber: 'C-1', firstName: 'Mia', lastName: 'Khan', status: 'REFERRED', intakeWorkflowStatus: 'NOT_SENT' });
    W.guardian = (await M.Guardian.create({ clientId: c._id, firstName: 'Sarah', lastName: 'Khan', phone: '5551234567', email: 'sarah@example.com', relationship: 'PARENT', isPrimary: true }))._id;
    W.client = c._id;
  });
});
after(async () => { if (skip) return; await mongoose?.disconnect(); await server?.stop(); });

const alertCodes = async () => (await clientsService.getChildAlerts({ tenantId: W.T, clientId: W.client })).alerts;

test('Add ABA and Add FBA persist immediately — listed after a reload, NOT_SENT (not approved), no transition needed', { skip }, async () => {
  const before = await alertCodes();
  assert.ok(before.some((a) => a.code === 'ABA_MISSING'), 'nothing on file yet');

  const aba = await clientsService.createServiceAuthorization({ tenantId: W.T, clientId: W.client, actorUserId: ACTOR,
    input: { serviceType: 'ABA', authorizationNumber: 'ABA-100', startDate: '2026-09-01', endDate: '2026-12-31', units: 160 } });
  const fba = await clientsService.createServiceAuthorization({ tenantId: W.T, clientId: W.client, actorUserId: ACTOR,
    input: { serviceType: 'FBA', authorizationNumber: 'FBA-100', units: 8 } });
  assert.equal(aba.status, 'NOT_SENT');
  assert.equal(fba.status, 'NOT_SENT');
  assert.deepEqual(aba.history, [], 'saving records no review/approval step');

  // A fresh read (what a page refresh does) returns both saved records.
  const listed = await clientsService.listServiceAuthorizations({ tenantId: W.T, clientId: W.client });
  assert.deepEqual(listed.map((a) => [a.serviceType, a.authorizationNumber, a.status]).sort(), [['ABA', 'ABA-100', 'NOT_SENT'], ['FBA', 'FBA-100', 'NOT_SENT']]);
  const raw = await withTenant(W.T, async () => await M.ServiceAuthorization.countDocuments({ clientId: W.client, deletedAt: null }));
  assert.equal(raw, 2);
  const detail = await clientsService.getClient({ tenantId: W.T, clientId: W.client });
  assert.equal(detail.serviceAuthorizations.length, 2, 'the client dashboard read includes them');

  // Alerts treat them as saved (an INFO follow-up), never as missing.
  const after = await alertCodes();
  assert.ok(!after.some((a) => a.code === 'ABA_MISSING' || a.code === 'FBA_MISSING'));
  assert.equal(after.find((a) => a.code === 'ABA_PENDING').severity, 'INFO');
  W.aba = aba;
});

test('the review/approval lifecycle is intact: approve still requires SENT; Mark sent → Approve works and is recorded', { skip }, async () => {
  await assert.rejects(
    clientsService.transitionServiceAuthorization({ tenantId: W.T, clientId: W.client, authorizationId: W.aba.id, actorUserId: ACTOR, target: 'APPROVED' }),
    (e) => e.code === 'AUTHORIZATION_TRANSITION_INVALID',
  );
  const sent = await clientsService.transitionServiceAuthorization({ tenantId: W.T, clientId: W.client, authorizationId: W.aba.id, actorUserId: ACTOR, target: 'SENT' });
  assert.equal(sent.status, 'SENT');
  const approved = await clientsService.transitionServiceAuthorization({ tenantId: W.T, clientId: W.client, authorizationId: W.aba.id, actorUserId: ACTOR, target: 'APPROVED' });
  assert.equal(approved.status, 'APPROVED');
  assert.deepEqual(approved.history.map((h) => `${h.from}>${h.to}`), ['NOT_SENT>SENT', 'SENT>APPROVED']);
  // Editing a saved authorization does not change its review status.
  const edited = await clientsService.updateServiceAuthorization({ tenantId: W.T, clientId: W.client, authorizationId: W.aba.id, actorUserId: ACTOR, input: { units: 200 } });
  assert.equal(edited.status, 'APPROVED');
  assert.equal(edited.units, 200);
});

test('Add insurance persists immediately as VERIFIED (active) — no manual verification step', { skip }, async () => {
  const created = await insuranceService.create({ tenantId: W.T, clientId: W.client, actorUserId: ACTOR,
    input: { payerName: 'Blue Shield', memberId: 'M-1', subscriberRelationship: 'PARENT', catalogInsuranceId: null, groupNumber: null, subscriberName: null, verificationStatus: 'FAILED' } });
  assert.equal(created.verificationStatus, 'VERIFIED', 'status is set by the server, never taken from the body');
  const listed = await insuranceService.listForClient({ tenantId: W.T, clientId: W.client });
  assert.deepEqual(listed.map((c) => [c.payerName, c.memberId, c.verificationStatus]), [['Blue Shield', 'M-1', 'VERIFIED']]);
  const doc = await withTenant(W.T, async () => M.InsuranceCoverage.findById(created.id).lean());
  assert.ok(doc.verifiedAt && doc.verifiedBy === ACTOR, 'verification is persisted on the record');
  assert.equal(doc.verificationHistory.at(-1).note, 'Verified automatically when the insurance was saved.');
  // A record a verifier marked as needing correction becomes active again once its details are saved.
  await insuranceService.verify({ tenantId: W.T, clientId: W.client, coverageId: created.id, actorUserId: ACTOR, status: 'NEEDS_CORRECTION', note: 'Wrong member id' });
  const fixed = await insuranceService.update({ tenantId: W.T, clientId: W.client, coverageId: created.id, actorUserId: ACTOR, input: { memberId: 'M-2' } });
  assert.equal(fixed.verificationStatus, 'VERIFIED');
});

test('a new authorization is usable immediately for booking and billing — no approval step', { skip }, async () => {
  const { isUsableServiceAuthorization, serviceAuthToBookable } = await import('../src/modules/scheduling/authAdapter.js');
  const created = await clientsService.createServiceAuthorization({ tenantId: W.T, clientId: W.client, actorUserId: ACTOR,
    input: { serviceType: 'FBA', authorizationNumber: 'AUTH-USABLE', units: 40, startDate: '2026-09-01', endDate: '2026-12-31' } });
  const doc = await withTenant(W.T, async () => M.ServiceAuthorization.findById(created.id).lean());
  assert.equal(isUsableServiceAuthorization(doc), true);
  assert.equal(serviceAuthToBookable(doc).status, 'ACTIVE');
  assert.equal(doc.unitPrice ?? null, null, 'an authorization carries no rate and needs none');
});

test('tenant isolation: another company cannot read or add to these records', { skip }, async () => {
  assert.deepEqual(await insuranceService.listForClient({ tenantId: W.T2, clientId: W.client }), []);
  await assert.rejects(clientsService.listServiceAuthorizations({ tenantId: W.T2, clientId: W.client }), (e) => e.code === 'CLIENT_NOT_FOUND');
  await assert.rejects(
    clientsService.createServiceAuthorization({ tenantId: W.T2, clientId: W.client, actorUserId: ACTOR, input: { serviceType: 'ABA' } }),
    (e) => e.code === 'CLIENT_NOT_FOUND',
  );
});

test('Edit Client persists through the existing versioned update (and a stale version is refused)', { skip }, async () => {
  const detail = await clientsService.getClient({ tenantId: W.T, clientId: W.client });
  const updated = await clientsService.updateClient({ tenantId: W.T, clientId: W.client, actorUserId: ACTOR, expectedVersion: detail.client.version,
    input: { preferredName: 'Mimi', address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' } } });
  const reread = await clientsService.getClient({ tenantId: W.T, clientId: W.client });
  assert.equal(reread.client.preferredName, 'Mimi');
  assert.equal(reread.client.address.city, 'Austin');
  assert.ok(updated.version > detail.client.version);
  await assert.rejects(
    clientsService.updateClient({ tenantId: W.T, clientId: W.client, actorUserId: ACTOR, expectedVersion: detail.client.version, input: { preferredName: 'Stale' } }),
    (e) => e.code === 'VERSION_CONFLICT',
  );
});

test('RBAC unchanged: add/edit/transition need clients.update, verification needs clients.verify_insurance; BCBA/RBT cannot add', { skip }, async () => {
  const router = createClientsRouter({});
  // Run each route's permission guard with a principal holding no permissions and read the key it demands.
  const demanded = async (method, path) => {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    const guard = layer.route.stack[0].handle;
    let error;
    await guard({ principal: { permissions: new Set() } }, {}, (e) => { error = e; });
    return /Missing permission: (\S+)/.exec(error?.message ?? '')?.[1];
  };
  assert.equal(await demanded('post', '/:clientId/authorizations'), 'clients.update');
  assert.equal(await demanded('patch', '/:clientId/authorizations/:authorizationId'), 'clients.update');
  assert.equal(await demanded('post', '/:clientId/authorizations/:authorizationId/transition'), 'clients.update');
  assert.equal(await demanded('post', '/:clientId/insurance'), 'clients.update');
  assert.equal(await demanded('post', '/:clientId/insurance/:coverageId/verification'), 'clients.verify_insurance');
  assert.equal(await demanded('patch', '/:clientId'), 'clients.update');
  const holds = (role, key) => SYSTEM_ROLE_TEMPLATES[role].some((g) => g.key === key);
  assert.ok(holds('owner', 'clients.update') && holds('org_admin', 'clients.update'));
  for (const role of ['bcba', 'rbt']) assert.equal(holds(role, 'clients.update'), false, `${role} cannot add FBA/ABA/insurance or edit the client`);
});
