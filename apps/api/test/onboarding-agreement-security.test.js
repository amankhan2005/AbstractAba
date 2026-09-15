import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnboardingService } from '../src/modules/onboarding/onboarding.service.js';
import { CompanyInvitationService, ONBOARDING_AGREEMENT } from '../src/modules/company-invitations/company-invitation.service.js';

// ============================================================================
// Agreement → agreementId → activation: the security-critical relationships.
//
// The onboarding pipeline itself (provision → record → countersign → activate →
// consume → auto-login) and its happy/edge paths are covered in
// company-onboarding-activation.test.js. This file pins the spec's explicit
// security properties: a real agreementId relationship, a correct acceptance
// timestamp, cross-tenant isolation of agreements, and expired-invitation
// rejection. All DB-free (faked existing services/repository).
// ============================================================================

// ---- cross-tenant isolation (spec TEST 15 & 16) ----------------------------

function onboardingServiceWithAgreements(agreementsByOrg) {
  let attachedTo = null;
  const svc = new OnboardingService({
    newId: () => 'new-id',
    organizations: { getById: async () => ({ state: 'PENDING_AGREEMENT', version: 2 }), transition: async () => {} },
    repository: {
      // Real service scoping: findAgreements is per-organization, so an agreement
      // that belongs to another org simply is not in this org's list.
      findAgreements: async (orgId) => (agreementsByOrg[orgId] ?? []),
      countersignAgreement: async ({ agreementId, userId }) => ({ id: agreementId, type: 'BUSINESS_ASSOCIATE', countersignedAt: new Date(), countersignedByUserId: userId }),
      attachAgreementToOrganization: async ({ organizationId }) => { attachedTo = organizationId; },
    },
  });
  return { svc, attached: () => attachedTo };
}

test('TEST 15/16 — an agreement belonging to another organization cannot satisfy activation (NOT_FOUND, never attached)', async () => {
  // org-A owns agreement a-A; org-B owns nothing. Attempting to countersign
  // org-B using org-A's agreement id must fail and must NOT attach anything.
  const { svc, attached } = onboardingServiceWithAgreements({
    'org-A': [{ id: 'a-A', type: 'BUSINESS_ASSOCIATE', countersignedAt: null }],
    'org-B': [],
  });
  await assert.rejects(
    () => svc.countersignAgreement({ organizationId: 'org-B', agreementId: 'a-A', actorUserId: 'op' }),
    (e) => e.code === 'NOT_FOUND',
  );
  assert.equal(attached(), null, 'no cross-tenant agreement was attached to org-B');
});

test('TEST 15/16 — the owning organization CAN countersign its own agreement (and it attaches to that org only)', async () => {
  const { svc, attached } = onboardingServiceWithAgreements({
    'org-A': [{ id: 'a-A', type: 'BUSINESS_ASSOCIATE', countersignedAt: null }],
  });
  await svc.countersignAgreement({ organizationId: 'org-A', agreementId: 'a-A', actorUserId: 'op' });
  assert.equal(attached(), 'org-A');
});

// ---- the real agreementId relationship + timestamp (spec TEST 3, 4, 18) -----

function acceptHarness(over = {}) {
  const recorded = [];
  const attached = [];
  const onboardingService = {
    provision: async () => {},
    listAgreements: async () => [],
    recordAgreement: async (i) => {
      recorded.push(i);
      // A REAL persisted id, distinct from the org id and the actor id.
      return { id: `agreement-${recorded.length}`, type: i.type, version: i.version, countersignedAt: null, executedAt: i.executedAt };
    },
    countersignAgreement: async (i) => { attached.push(i); return { id: i.agreementId, countersignedAt: new Date() }; },
    activate: async (i) => ({ id: i.organizationId, state: 'ACTIVE', version: (i.expectedVersion ?? 1) + 1 }),
  };
  const svc = new CompanyInvitationService({
    organizationService: {
      create: async () => ({ id: 'org-1', state: 'PROVISIONING' }),
      getById: async () => ({ id: 'org-1', state: 'PENDING_AGREEMENT', version: 2 }),
    },
    usersRepository: { createOwnerAccount: async () => ({ id: 'm-1' }) },
    onboardingService,
    authService: { establishSessionForEmail: async () => ({ status: 'OK', accessToken: 'AT', refreshToken: 'RT', user: { id: 'u1' }, activeTenantId: 'org-1' }) },
    jobQueue: {},
    ...over,
  });
  svc.resolveActive = async () => ({ email: 'owner@clinic.test', invitedByUserId: 'operator-1', consumedAt: null, revokedAt: null, expiresAt: new Date(Date.now() + 3600_000), save: async () => {} });
  return { svc, recorded, attached, onboardingService };
}

const body = () => ({
  slug: 'bright-aba', legalName: 'Bright ABA LLC', tradingName: 'Bright ABA',
  countryCode: 'US', timezone: 'America/New_York', primaryContactName: 'Jordan Lee',
  password: 'a-strong-password-1', agreement: { accepted: true, acceptedByTitle: 'Owner' },
});

test('TEST 3/4 — the organization is attached to the REAL persisted agreement id (not org id, user id, null, or hardcoded)', async () => {
  const { svc, recorded, attached } = acceptHarness();
  await svc.accept('tok', body(), { requestIp: '203.0.113.1' });
  assert.equal(recorded.length, 1);
  const realId = 'agreement-1';
  // The id attached to the org is exactly the recorded agreement's id.
  assert.equal(attached.length, 1);
  assert.equal(attached[0].agreementId, realId);
  assert.equal(attached[0].organizationId, 'org-1');
  // And it is a real id, never a stand-in.
  assert.notEqual(attached[0].agreementId, null);
  assert.notEqual(attached[0].agreementId, 'org-1'); // not the organization id
  assert.notEqual(attached[0].agreementId, 'operator-1'); // not a user id
});

test('TEST 18 — the acceptance/execution timestamp is recorded as a real Date', async () => {
  const { svc, recorded } = acceptHarness();
  const before = Date.now();
  await svc.accept('tok', body(), {});
  const after = Date.now();
  assert.ok(recorded[0].executedAt instanceof Date, 'executedAt must be a Date');
  const t = recorded[0].executedAt.getTime();
  assert.ok(t >= before && t <= after, 'executedAt is the actual acceptance time');
  assert.equal(recorded[0].type, ONBOARDING_AGREEMENT.type);
});

// ---- expired / invalid invitation (spec TEST 13) ---------------------------

test('TEST 13 — an expired invitation is rejected and NOTHING is created or activated', async () => {
  let created = false;
  const { svc, onboardingService } = acceptHarness({
    organizationService: {
      create: async () => { created = true; return { id: 'org-1', state: 'PROVISIONING' }; },
      getById: async () => ({ id: 'org-1', state: 'PENDING_AGREEMENT', version: 2 }),
    },
  });
  // Simulate resolveActive's real behaviour for an expired token.
  svc.resolveActive = async () => { const e = new Error('This invitation is invalid or has expired.'); e.code = 'COMPANY_INVITE-404'; throw e; };
  let activated = false;
  onboardingService.activate = async () => { activated = true; return { state: 'ACTIVE' }; };
  await assert.rejects(() => svc.accept('tok', body(), {}), (e) => e.code === 'COMPANY_INVITE-404');
  assert.equal(created, false, 'no organization created for an expired invitation');
  assert.equal(activated, false, 'nothing activated for an expired invitation');
});
