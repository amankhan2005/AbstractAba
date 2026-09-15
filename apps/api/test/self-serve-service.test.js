import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SelfServeService } from '../src/modules/self-serve/selfServe.service.js';

// Fakes capture the exact calls the orchestration makes to existing services.
function makeService(over = {}) {
  const calls = { create: [], provision: [], recordAgreement: [], invite: [], transition: [] };
  const deps = {
    organizations: {
      create: async (input) => { calls.create.push(input); if (input.slug === 'taken') { const e = new Error('slug taken'); e.code = 'SLUG_TAKEN'; e.status = 409; throw e; } return { id: 'org-1', slug: input.slug, state: 'PROVISIONING', version: 1 }; },
      transition: async (input) => { calls.transition.push(input); },
    },
    onboarding: {
      provision: async (input) => { calls.provision.push(input); return { state: 'PENDING_AGREEMENT' }; },
      recordAgreement: async (input) => { calls.recordAgreement.push(input); return { id: 'agr-1' }; },
    },
    users: {
      inviteInitialOwner: async (input) => { calls.invite.push(input); return { member: { id: 'm-1' }, invitation: { id: 'inv-1' }, token: 'SECRET-TOKEN' }; },
    },
    ...over,
  };
  return { service: new SelfServeService(deps), calls };
}

const validInput = {
  slug: 'bright-aba', legalName: 'Bright ABA LLC', tradingName: 'Bright ABA',
  countryCode: 'us', timezone: 'America/New_York',
  ownerFullName: 'Jane Doe', ownerEmail: 'Jane@Bright.com',
  agreement: { version: 'v1', acceptedByName: 'Jane Doe', acceptedByTitle: 'CEO', accepted: true },
};

test('signup orchestrates create → provision → recordAgreement → inviteOwner in order', async () => {
  const { service, calls } = makeService();
  const res = await service.signup({ input: validInput, requestIp: '203.0.113.5' });
  assert.equal(calls.create.length, 1);
  assert.equal(calls.provision.length, 1);
  assert.equal(calls.recordAgreement.length, 1);
  assert.equal(calls.invite.length, 1);
  assert.equal(res.organizationId, 'org-1');
  assert.equal(res.state, 'PENDING_AGREEMENT');
});

test('signup preserves the gate: it never activates the organization', async () => {
  const { service, calls } = makeService();
  await service.signup({ input: validInput, requestIp: null });
  // No transition to ACTIVE is ever requested by self-serve.
  assert.ok(!calls.transition.some((t) => t.toState === 'ACTIVE'));
});

test('signup records a BUSINESS_ASSOCIATE agreement with the signer + request IP', async () => {
  const { service, calls } = makeService();
  await service.signup({ input: validInput, requestIp: '203.0.113.9' });
  const agr = calls.recordAgreement[0];
  assert.equal(agr.type, 'BUSINESS_ASSOCIATE');
  assert.equal(agr.executedByName, 'Jane Doe');
  assert.equal(agr.executedIp, '203.0.113.9');
  assert.equal(agr.actorUserId, null); // system action, no operator
});

test('signup normalizes email + country and passes owner as primary contact', async () => {
  const { service, calls } = makeService();
  await service.signup({ input: validInput, requestIp: null });
  assert.equal(calls.create[0].countryCode, 'US');
  assert.equal(calls.create[0].primaryContactEmail, 'jane@bright.com');
  assert.equal(calls.invite[0].email, 'jane@bright.com');
  assert.equal(calls.invite[0].invitedByUserId, null);
});

test('signup never leaks the invitation token in its response', async () => {
  const { service } = makeService();
  const res = await service.signup({ input: validInput, requestIp: null });
  assert.ok(!JSON.stringify(res).includes('SECRET-TOKEN'));
  assert.equal(res.invitationId, 'inv-1');
});

test('duplicate slug surfaces the existing conflict (no partial owner invite)', async () => {
  const { service, calls } = makeService();
  await assert.rejects(() => service.signup({ input: { ...validInput, slug: 'taken' }, requestIp: null }), (e) => e.code === 'SLUG_TAKEN');
  // Fail fast at create → nothing downstream ran.
  assert.equal(calls.provision.length, 0);
  assert.equal(calls.invite.length, 0);
});

test('signup accepts no client-supplied tenant/state/role (only maps known fields)', async () => {
  const { service, calls } = makeService();
  const polluted = { ...validInput, tenantId: 'evil', state: 'ACTIVE', roleKeys: ['owner'], id: 'evil-id' };
  await service.signup({ input: polluted, requestIp: null });
  const created = calls.create[0];
  assert.equal(created.tenantId, undefined);
  assert.equal(created.state, undefined);
  assert.equal(created.id, undefined);
  assert.equal(created.roleKeys, undefined);
});
