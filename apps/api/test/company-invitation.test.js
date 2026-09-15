import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompanyInvitationService, COMPANY_INVITATION_DELIVERY_JOB } from '../src/modules/company-invitations/company-invitation.service.js';

// A fake onboarding service that records the calls accept() makes and mimics the
// real lifecycle: provision (→ PENDING_AGREEMENT), record + countersign the BAA
// (which attaches agreementId and thereby unlocks activation), then activate.
function makeOnboarding(over = {}) {
  const calls = { provision: [], listAgreements: [], recordAgreement: [], countersign: [], activate: [] };
  const agreements = [];
  const svc = {
    calls,
    agreements,
    provision: async (i) => { calls.provision.push(i); },
    listAgreements: async () => { calls.listAgreements.push(true); return agreements.slice(); },
    recordAgreement: async (i) => { calls.recordAgreement.push(i); const a = { id: 'agr-1', type: i.type, version: i.version, countersignedAt: null }; agreements.push(a); return a; },
    countersignAgreement: async (i) => { calls.countersign.push(i); const a = agreements.find((x) => x.id === i.agreementId); if (a) a.countersignedAt = new Date(); return a; },
    activate: async (i) => { calls.activate.push(i); return { id: i.organizationId, state: 'ACTIVE', version: (i.expectedVersion ?? 1) + 1 }; },
    ...over,
  };
  return svc;
}

// The service depends on the CompanyInvitation model (Mongoose) for persistence,
// which needs a DB. These tests exercise the DB-free surface: the delivery-job
// contract and status derivation, plus the accept flow's delegation to the
// organization service (which we fake). Persistence paths are covered by the
// live-DB flow, which is documented as unexecutable in this sandbox.

test('toSummary derives status from timestamps', () => {
  const svc = new CompanyInvitationService({ organizationService: {}, jobQueue: {} });
  const base = { _id: 'i1', email: 'a@b.co', expiresAt: new Date(Date.now() + 3600_000), createdAt: new Date() };
  assert.equal(svc.toSummary({ ...base, consumedAt: null, revokedAt: null }).status, 'PENDING');
  assert.equal(svc.toSummary({ ...base, consumedAt: new Date(), revokedAt: null }).status, 'ACCEPTED');
  assert.equal(svc.toSummary({ ...base, consumedAt: null, revokedAt: new Date() }).status, 'REVOKED');
  assert.equal(
    svc.toSummary({ ...base, expiresAt: new Date(Date.now() - 1000), consumedAt: null, revokedAt: null }).status,
    'EXPIRED',
  );
});

test('toSummary never leaks a token or hash', () => {
  const svc = new CompanyInvitationService({ organizationService: {}, jobQueue: {} });
  const summary = svc.toSummary({
    _id: 'i1', email: 'a@b.co', tokenHash: 'deadbeef', expiresAt: new Date(), createdAt: new Date(),
    consumedAt: null, revokedAt: null,
  });
  assert.ok(!('tokenHash' in summary));
  assert.ok(!('token' in summary));
});

test('delivery job type is stable', () => {
  assert.equal(COMPANY_INVITATION_DELIVERY_JOB, 'company_invitation.deliver');
});

test('expiry is in the future and honors ttlHours', () => {
  const svc = new CompanyInvitationService({ organizationService: {}, jobQueue: {}, ttlHours: 48 });
  const now = Date.now();
  const exp = svc.expiry().getTime();
  // ~48h from now (allow a small execution delta)
  assert.ok(exp > now + 47 * 3600_000 && exp < now + 49 * 3600_000);
});

// Regression test for the two real bugs this session fixed:
//   1. accept() used to create ONLY the organization — no user, no password,
//      no membership — so the invited company could never log in.
//   2. When the membership WAS eventually created, tenantId had to come from
//      the organization the service itself just created, never from caller
//      input — a client-supplied tenantId must never reach the Membership
//      document (the "Membership validation failed: tenantId is required"
//      class of bug, and its worse sibling, a forged tenantId).
// Both organizationService and usersRepository are faked, so this runs
// without a database and pins the exact call contract between them.
test('accept() creates the owner account with the tenantId taken from the newly created org, never from caller input', async () => {
  const resolvedActive = {
    email: 'owner@clinic.test',
    consumedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 3600_000),
    save: async () => {},
  };

  resolvedActive.invitedByUserId = 'operator-9';

  const createdOrg = { id: 'org-123', state: 'PROVISIONING' };
  let orgCreateCalledWith = null;
  const organizationService = {
    create: async (input) => {
      orgCreateCalledWith = input;
      return createdOrg;
    },
    // After provisioning, the org sits at PENDING_AGREEMENT with a bumped version.
    getById: async () => ({ id: 'org-123', state: 'PENDING_AGREEMENT', version: 2 }),
  };

  let ownerAccountCalledWith = null;
  const usersRepository = {
    createOwnerAccount: async (input) => {
      ownerAccountCalledWith = input;
      return { id: 'membership-1' };
    },
  };

  const onboardingService = makeOnboarding();
  const authService = { establishSessionForEmail: async () => ({ status: 'OK', accessToken: 'AT', refreshToken: 'RT', user: { id: 'u1' }, activeTenantId: 'org-123' }) };

  const svc = new CompanyInvitationService({ organizationService, jobQueue: {}, usersRepository, onboardingService, authService });
  svc.resolveActive = async () => resolvedActive; // bypass the DB-backed token lookup

  const result = await svc.accept('raw-token', {
    slug: 'sunrise-aba',
    legalName: 'Sunrise ABA Therapy, LLC',
    tradingName: 'Sunrise ABA',
    countryCode: 'US',
    timezone: 'America/Los_Angeles',
    primaryContactName: 'Jordan Lee',
    password: 'a-strong-password-1',
    agreement: { accepted: true, acceptedByTitle: 'Owner' },
    // Deliberately trying to smuggle a tenantId — must be ignored entirely;
    // createOwnerAccount must only ever see org.id (`createdOrg.id`).
    tenantId: 'attacker-supplied-tenant',
  });

  assert.equal(result.organizationId, 'org-123');
  assert.equal(result.state, 'ACTIVE'); // onboarding now activates the org
  assert.equal(orgCreateCalledWith.primaryContactEmail, 'owner@clinic.test'); // defaulted from the invitation
  assert.ok(ownerAccountCalledWith, 'createOwnerAccount must be called during accept()');
  assert.equal(ownerAccountCalledWith.tenantId, 'org-123'); // from the org the service just created
  assert.notEqual(ownerAccountCalledWith.tenantId, 'attacker-supplied-tenant');
  assert.equal(ownerAccountCalledWith.email, 'owner@clinic.test');
  assert.ok(ownerAccountCalledWith.passwordHash, 'password must be hashed before reaching the repository');
  assert.notEqual(ownerAccountCalledWith.passwordHash, 'a-strong-password-1'); // never the plaintext
  assert.equal(resolvedActive.consumedAt instanceof Date, true); // invitation consumed only after both succeed
  assert.equal(resolvedActive.organizationId, 'org-123');
});
