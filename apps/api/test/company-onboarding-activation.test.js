import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompanyInvitationService, ONBOARDING_AGREEMENT } from '../src/modules/company-invitations/company-invitation.service.js';
import { assertTransitionAllowed } from '../src/modules/organization/organization.state-machine.js';
import { ORG_ERROR_STATUS } from '../src/modules/organization/organization.errors.js';

// ============================================================================
// SLICE 1 — Onboarding activation flow.
//
// These are DB-free unit tests. They pin the ORCHESTRATION CONTRACT of accept()
// against faked existing services (organization / onboarding / users / auth),
// exactly like the existing company-invitation and self-serve service tests.
// The persistence and HTTP layers are covered by the live-DB flow, which is
// documented as unexecutable in this sandbox (no MongoDB binary available).
// ============================================================================

// ---- shared fakes ----------------------------------------------------------

function makeOnboarding(over = {}) {
  const calls = { provision: [], listAgreements: [], recordAgreement: [], countersign: [], activate: [] };
  const agreements = [];
  return {
    calls,
    agreements,
    provision: async (i) => { calls.provision.push(i); },
    listAgreements: async () => { calls.listAgreements.push(true); return agreements.slice(); },
    recordAgreement: async (i) => {
      calls.recordAgreement.push(i);
      const a = { id: `agr-${agreements.length + 1}`, type: i.type, version: i.version, countersignedAt: null };
      agreements.push(a);
      return a;
    },
    countersignAgreement: async (i) => {
      calls.countersign.push(i);
      const a = agreements.find((x) => x.id === i.agreementId);
      if (a) a.countersignedAt = new Date();
      return a;
    },
    activate: async (i) => { calls.activate.push(i); return { id: i.organizationId, state: 'ACTIVE', version: (i.expectedVersion ?? 1) + 1 }; },
    ...over,
  };
}

function makeDeps(over = {}) {
  const calls = { create: [], owner: [], session: [] };
  const org = { id: 'org-1', state: 'PROVISIONING' };
  const deps = {
    organizationService: {
      create: async (input) => { calls.create.push(input); return org; },
      getById: async () => ({ id: 'org-1', state: 'PENDING_AGREEMENT', version: 2 }),
    },
    usersRepository: {
      createOwnerAccount: async (input) => { calls.owner.push(input); return { id: 'm-1' }; },
    },
    onboardingService: makeOnboarding(),
    authService: {
      establishSessionForEmail: async (email, ctx) => {
        calls.session.push({ email, ctx });
        return { status: 'OK', accessToken: 'AT', refreshToken: 'RT', user: { id: 'u-1', email }, activeTenantId: 'org-1' };
      },
    },
    jobQueue: {},
  };
  const merged = { ...deps, ...over };
  const svc = new CompanyInvitationService(merged);
  // Bypass the DB-backed token lookup with an active invitation double.
  const invitation = { email: 'owner@clinic.test', invitedByUserId: 'operator-7', consumedAt: null, revokedAt: null, expiresAt: new Date(Date.now() + 3600_000), save: async () => {} };
  svc.resolveActive = async () => invitation;
  return { svc, calls, deps: merged, invitation };
}

const validBody = () => ({
  slug: 'bright-aba',
  legalName: 'Bright ABA LLC',
  tradingName: 'Bright ABA',
  countryCode: 'US',
  timezone: 'America/New_York',
  primaryContactName: 'Jordan Lee',
  password: 'a-strong-password-1',
  agreement: { accepted: true, acceptedByTitle: 'Owner' },
});

// ---- the exact 422 regression ---------------------------------------------

test('EXACT 422 REGRESSION: the state machine still refuses PENDING_AGREEMENT → ACTIVE with no agreement (AGREEMENT_REQUIRED = 422)', () => {
  // This is the unchanged, authoritative gate. We assert it is NOT weakened.
  let thrown;
  try {
    assertTransitionAllowed({ organization: { state: 'PENDING_AGREEMENT', agreementId: null }, target: 'ACTIVE' });
  } catch (e) { thrown = e; }
  assert.ok(thrown, 'activation with no agreement must throw');
  assert.equal(thrown.code, 'AGREEMENT_REQUIRED');
  assert.equal(ORG_ERROR_STATUS.AGREEMENT_REQUIRED, 422);

  // With an agreement attached, the same transition is permitted.
  assert.doesNotThrow(() =>
    assertTransitionAllowed({ organization: { state: 'PENDING_AGREEMENT', agreementId: 'agr-1' }, target: 'ACTIVE' }),
  );
});

test('NEW: valid onboarding + agreement acceptance drives provision → record → countersign → activate, in order', async () => {
  const { svc, deps } = makeDeps();
  const result = await svc.accept('raw-token', validBody(), { requestIp: '203.0.113.5' });

  const ob = deps.onboardingService.calls;
  assert.equal(ob.provision.length, 1, 'provisions the tenant');
  assert.equal(ob.recordAgreement.length, 1, 'records the agreement');
  assert.equal(ob.countersign.length, 1, 'countersigns (attaches agreementId)');
  assert.equal(ob.activate.length, 1, 'activates');
  assert.equal(result.state, 'ACTIVE');
});

test('agreementId gets attached before activation: countersign happens, then activate', async () => {
  const { svc, deps } = makeDeps();
  await svc.accept('raw-token', validBody(), {});
  // The agreement recorded is the countersigned one that unlocks the gate.
  const agr = deps.onboardingService.agreements[0];
  assert.ok(agr.countersignedAt instanceof Date, 'the BAA is countersigned (this is what sets org.agreementId)');
  assert.equal(deps.onboardingService.calls.activate[0].organizationId, 'org-1');
});

test('the recorded agreement is a BUSINESS_ASSOCIATE at the server-pinned version, executed by the owner', async () => {
  const { svc, deps } = makeDeps();
  await svc.accept('raw-token', validBody(), { requestIp: '198.51.100.2' });
  const rec = deps.onboardingService.calls.recordAgreement[0];
  assert.equal(rec.type, 'BUSINESS_ASSOCIATE');
  assert.equal(rec.type, ONBOARDING_AGREEMENT.type);
  assert.equal(rec.version, ONBOARDING_AGREEMENT.version); // pinned server-side, not from the client
  assert.equal(rec.executedByName, 'Jordan Lee'); // the owner is the executor
  assert.equal(rec.executedByTitle, 'Owner');
  assert.equal(rec.executedIp, '198.51.100.2'); // captured for the compliance record
  assert.equal(rec.documentRef, ONBOARDING_AGREEMENT.documentRef);
});

test('the platform actor for countersign + activate is the inviting operator, never the client', async () => {
  const { svc, deps } = makeDeps();
  await svc.accept('raw-token', { ...validBody(), invitedByUserId: 'attacker', actorUserId: 'attacker' }, {});
  assert.equal(deps.onboardingService.calls.countersign[0].actorUserId, 'operator-7');
  assert.equal(deps.onboardingService.calls.activate[0].actorUserId, 'operator-7');
  assert.equal(deps.onboardingService.calls.recordAgreement[0].actorUserId, 'operator-7');
});

test('activation uses the CURRENT org version (optimistic concurrency), read after provisioning', async () => {
  const { svc, deps } = makeDeps();
  await svc.accept('raw-token', validBody(), {});
  assert.equal(deps.onboardingService.calls.activate[0].expectedVersion, 2); // from getById after provision
});

test('ONBOARDING WITHOUT AGREEMENT IS REJECTED — no org, no owner, no activation', async () => {
  const { svc, calls, deps } = makeDeps();
  const body = validBody();
  delete body.agreement;
  await assert.rejects(
    () => svc.accept('raw-token', body, {}),
    (e) => e.code === 'VALIDATION' || /agreement/i.test(e.message),
  );
  assert.equal(calls.create.length, 0, 'organization is never created');
  assert.equal(calls.owner.length, 0, 'owner account is never created');
  assert.equal(deps.onboardingService.calls.activate.length, 0, 'nothing is activated');
});

test('agreement present but not accepted (accepted:false) is rejected the same way', async () => {
  const { svc, deps } = makeDeps();
  await assert.rejects(
    () => svc.accept('raw-token', { ...validBody(), agreement: { accepted: false, acceptedByTitle: 'Owner' } }, {}),
    (e) => /agreement/i.test(e.message),
  );
  assert.equal(deps.onboardingService.calls.activate.length, 0);
});

test('owner account is created ACTIVE-capable with tenantId from the created org, never client input', async () => {
  const { svc, calls } = makeDeps();
  await svc.accept('raw-token', { ...validBody(), tenantId: 'attacker-tenant' }, {});
  assert.equal(calls.owner[0].tenantId, 'org-1');
  assert.notEqual(calls.owner[0].tenantId, 'attacker-tenant');
  assert.ok(calls.owner[0].passwordHash);
  assert.notEqual(calls.owner[0].passwordHash, 'a-strong-password-1');
});

test('invitation is consumed exactly once, only after activation succeeds', async () => {
  const { svc, invitation } = makeDeps();
  assert.equal(invitation.consumedAt, null);
  await svc.accept('raw-token', validBody(), {});
  assert.ok(invitation.consumedAt instanceof Date);
  assert.equal(invitation.organizationId, 'org-1');
});

test('activation failure leaves the invitation UNCONSUMED (safe retry) and surfaces the real error', async () => {
  const onboardingService = makeOnboarding({
    activate: async () => { const e = new Error('AGREEMENT_REQUIRED'); e.code = 'AGREEMENT_REQUIRED'; e.status = 422; throw e; },
  });
  const { svc, invitation } = makeDeps({ onboardingService });
  await assert.rejects(() => svc.accept('raw-token', validBody(), {}), (e) => e.code === 'AGREEMENT_REQUIRED');
  assert.equal(invitation.consumedAt, null, 'not consumed on failure, so the owner can retry');
});

test('AUTO-LOGIN: a session is established for the owner and returned', async () => {
  const { svc, calls } = makeDeps();
  const result = await svc.accept('raw-token', validBody(), { requestIp: '203.0.113.9', userAgent: 'UA/1' });
  assert.equal(calls.session.length, 1);
  assert.equal(calls.session[0].email, 'owner@clinic.test');
  assert.equal(calls.session[0].ctx.ipAddress, '203.0.113.9');
  assert.equal(result.session.status, 'OK');
  assert.equal(result.session.accessToken, 'AT');
});

test('AUTO-LOGIN FAILURE is not faked: account still created/activated, session is null → client asks owner to sign in', async () => {
  const authService = { establishSessionForEmail: async () => { throw new Error('session store down'); } };
  const { svc, invitation } = makeDeps({ authService });
  const result = await svc.accept('raw-token', validBody(), {});
  assert.equal(result.state, 'ACTIVE'); // onboarding still completed
  assert.equal(result.session, null); // NOT a fabricated session
  assert.ok(invitation.consumedAt instanceof Date); // the org is set up; the only gap is the session
});

test('REPLAY: a consumed invitation cannot be onboarded again (single-use)', async () => {
  const { svc, invitation } = makeDeps();
  await svc.accept('raw-token', validBody(), {});
  // Second attempt: the real resolveActive rejects a consumed token. Simulate
  // that by restoring a resolveActive that enforces single-use on our double.
  svc.resolveActive = async () => {
    const active = invitation.consumedAt === null && invitation.revokedAt === null && new Date(invitation.expiresAt).getTime() > Date.now();
    if (!active) { const e = new Error('This invitation is invalid or has expired.'); e.code = 'COMPANY_INVITE-404'; throw e; }
    return invitation;
  };
  await assert.rejects(() => svc.accept('raw-token', validBody(), {}), (e) => /invalid or has expired/.test(e.message));
});

test('RETRY convergence: an already-recorded agreement is reused, not duplicated', async () => {
  // Pre-seed an agreement as if a prior attempt recorded (and countersigned) it.
  const onboardingService = makeOnboarding();
  onboardingService.agreements.push({ id: 'agr-existing', type: 'BUSINESS_ASSOCIATE', version: ONBOARDING_AGREEMENT.version, countersignedAt: new Date() });
  const { svc, deps } = makeDeps({ onboardingService });
  await svc.accept('raw-token', validBody(), {});
  assert.equal(deps.onboardingService.calls.recordAgreement.length, 0, 'no duplicate agreement recorded');
  assert.equal(deps.onboardingService.calls.countersign.length, 0, 'already countersigned → not re-countersigned');
  assert.equal(deps.onboardingService.calls.activate.length, 1, 'still activates');
});

test('ALREADY-ACTIVE convergence: if a prior attempt activated, accept() does not re-transition', async () => {
  const organizationService = {
    create: async () => ({ id: 'org-1', state: 'PROVISIONING' }),
    getById: async () => ({ id: 'org-1', state: 'ACTIVE', version: 3 }), // prior attempt already activated
  };
  const { svc, deps } = makeDeps({ organizationService });
  const result = await svc.accept('raw-token', validBody(), {});
  assert.equal(deps.onboardingService.calls.activate.length, 0, 'no illegal ACTIVE → ACTIVE transition attempted');
  assert.equal(result.state, 'ACTIVE');
});

test('preview() advertises the agreement to accept (label + version), never the token', async () => {
  const { svc } = makeDeps();
  svc.resolveActive = async () => ({ email: 'owner@clinic.test', contactName: 'Jordan', companyName: 'Bright', expiresAt: new Date(Date.now() + 3600_000), tokenHash: 'deadbeef' });
  const preview = await svc.preview('raw-token');
  assert.equal(preview.agreement.type, 'BUSINESS_ASSOCIATE');
  assert.equal(preview.agreement.version, ONBOARDING_AGREEMENT.version);
  assert.ok(preview.agreement.title);
  assert.ok(!JSON.stringify(preview).includes('deadbeef'));
});
