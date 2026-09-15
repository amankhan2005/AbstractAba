import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  allowedTransitionsFrom,
  mayStoreClinicalData,
  maySignIn,
  assertTransitionAllowed,
} from '../src/modules/organization/organization.state-machine.js';
import { isSlugAcceptable, assertSlugAcceptable } from '../src/modules/organization/organization.slug.js';
import { OrganizationService } from '../src/modules/organization/organization.service.js';

/**
 * DB-free tests for the organization module: the lifecycle state machine, slug
 * rules, and service business logic exercised against a fake repository. These
 * mirror the guarantees of the original module's unit tests.
 */

// --- state machine ---------------------------------------------------------

test('lifecycle: only the permitted transitions are allowed', () => {
  assert.equal(canTransition('PROVISIONING', 'PENDING_AGREEMENT'), true);
  assert.equal(canTransition('PENDING_AGREEMENT', 'ACTIVE'), true);
  assert.equal(canTransition('ACTIVE', 'SUSPENDED'), true);
  assert.equal(canTransition('SUSPENDED', 'ACTIVE'), true);
  assert.equal(canTransition('OFFBOARDING', 'DESTROYED'), true);
  // illegal jumps
  assert.equal(canTransition('PROVISIONING', 'ACTIVE'), false);
  assert.equal(canTransition('ACTIVE', 'DESTROYED'), false);
  assert.equal(canTransition('DESTROYED', 'ACTIVE'), false);
  assert.deepEqual([...allowedTransitionsFrom('DESTROYED')], []);
});

test('clinical-data gate: only ACTIVE may store PHI', () => {
  for (const s of ['PROVISIONING', 'PENDING_AGREEMENT', 'SUSPENDED', 'OFFBOARDING', 'DESTROYED']) {
    assert.equal(mayStoreClinicalData(s), false, `${s} must not store clinical data`);
  }
  assert.equal(mayStoreClinicalData('ACTIVE'), true);
});

test('sign-in gate: destroyed and provisioning tenants cannot sign in', () => {
  assert.equal(maySignIn('ACTIVE'), true);
  assert.equal(maySignIn('PENDING_AGREEMENT'), true);
  assert.equal(maySignIn('SUSPENDED'), true);
  assert.equal(maySignIn('OFFBOARDING'), true);
  assert.equal(maySignIn('PROVISIONING'), false);
  assert.equal(maySignIn('DESTROYED'), false);
});

test('activation requires an executed agreement', () => {
  assert.throws(
    () => assertTransitionAllowed({ organization: { state: 'PENDING_AGREEMENT', agreementId: null }, target: 'ACTIVE' }),
    (e) => e.code === 'AGREEMENT_REQUIRED',
  );
  // with an agreement it passes
  assert.doesNotThrow(() =>
    assertTransitionAllowed({ organization: { state: 'PENDING_AGREEMENT', agreementId: 'agr-1' }, target: 'ACTIVE' }),
  );
});

test('destruction: separation of duties and preconditions', () => {
  const base = { organization: { state: 'OFFBOARDING' }, target: 'DESTROYED' };
  // missing details
  assert.throws(() => assertTransitionAllowed(base), (e) => e.code === 'DESTRUCTION_PRECONDITIONS_UNMET');
  // same actor requests and approves
  assert.throws(
    () => assertTransitionAllowed({ ...base, destruction: { requestedByUserId: 'u1', approvedByUserId: 'u1', exportCompleted: true, graceElapsed: true } }),
    (e) => e.code === 'SAME_ACTOR_APPROVAL',
  );
  // export not complete / grace not elapsed
  assert.throws(
    () => assertTransitionAllowed({ ...base, destruction: { requestedByUserId: 'u1', approvedByUserId: 'u2', exportCompleted: false, graceElapsed: true } }),
    (e) => e.code === 'DESTRUCTION_PRECONDITIONS_UNMET',
  );
  // all preconditions met
  assert.doesNotThrow(() =>
    assertTransitionAllowed({ ...base, destruction: { requestedByUserId: 'u1', approvedByUserId: 'u2', exportCompleted: true, graceElapsed: true } }),
  );
});

// --- slug ------------------------------------------------------------------

test('slug rules: format and reserved words', () => {
  assert.equal(isSlugAcceptable('bright-aba'), true);
  assert.equal(isSlugAcceptable('ab'), false);          // too short
  assert.equal(isSlugAcceptable('-lead'), false);       // leading hyphen
  assert.equal(isSlugAcceptable('UPPER'), false);       // uppercase
  assert.equal(isSlugAcceptable('admin'), false);       // reserved
  assert.equal(isSlugAcceptable('billing'), false);     // reserved (phishing vector)
  assert.throws(() => assertSlugAcceptable('api'), (e) => e.code === 'SLUG_RESERVED');
  assert.throws(() => assertSlugAcceptable('x'), (e) => e.code === 'SLUG_INVALID');
});

// --- service (fake repository) ---------------------------------------------

function fakeRepo(overrides = {}) {
  return {
    created: [],
    slugExists: async () => false,
    create: async (input) => ({ id: input.id, ...input, state: 'PROVISIONING', version: 1 }),
    findById: async (id) => ({
      id, slug: 'clinic', state: 'ACTIVE', tradingName: 'Clinic', legalName: 'Clinic LLC',
      countryCode: 'US', stateCode: 'CA', timezone: 'America/Los_Angeles', locale: 'en-US',
      primaryContactName: 'A B', primaryContactEmail: 'a@b.test', agreementId: 'agr', version: 3,
      offboardingAt: null, destructionGraceDays: null,
    }),
    applyTransition: async (i) => ({ id: i.organizationId, state: i.toState, version: i.expectedVersion + 1 }),
    updateProfile: async (i) => ({ id: i.organizationId, slug: 'clinic', state: 'ACTIVE', tradingName: i.changes.tradingName ?? 'Clinic', legalName: 'Clinic LLC', countryCode: 'US', stateCode: 'CA', timezone: 'America/Los_Angeles', locale: 'en-US', primaryContactName: 'A B', primaryContactEmail: 'a@b.test', version: i.expectedVersion + 1 }),
    listMembershipsForUser: async () => [
      { membershipId: 'm1', organizationId: 'o1', organizationSlug: 'a', organizationTradingName: 'A', organizationState: 'ACTIVE', isOwner: true, status: 'ACTIVE' },
      { membershipId: 'm2', organizationId: 'o2', organizationSlug: 'b', organizationTradingName: 'B', organizationState: 'DESTROYED', isOwner: false, status: 'ACTIVE' },
      { membershipId: 'm3', organizationId: 'o3', organizationSlug: 'c', organizationTradingName: 'C', organizationState: 'ACTIVE', isOwner: false, status: 'REMOVED' },
    ],
    findByHost: async () => null,
    summariseUsage: async () => [],
    ...overrides,
  };
}

function makeService(repo) {
  return new OrganizationService({
    repository: repo,
    newId: () => '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a01',
    destructionGraceDays: 30,
    defaultBranding: { tradingName: 'Abstract ABA', logoUrl: null, accent: '#1172A3' },
  });
}

test('create rejects a taken slug', async () => {
  const svc = makeService(fakeRepo({ slugExists: async () => true }));
  await assert.rejects(
    () => svc.create({ slug: 'bright-aba', legalName: 'X', tradingName: 'X', countryCode: 'US', timezone: 'UTC', primaryContactName: 'A B', primaryContactEmail: 'a@b.test' }),
    (e) => e.code === 'SLUG_TAKEN',
  );
});

test('membership switcher hides destroyed tenants and non-active memberships', async () => {
  const svc = makeService(fakeRepo());
  const list = await svc.listMembershipsForUser('user-1');
  assert.equal(list.length, 1);
  assert.equal(list[0].organizationId, 'o1');
});

test('resolveSwitchTarget refuses an organization the user has no active membership in', async () => {
  const svc = makeService(fakeRepo());
  await assert.rejects(
    () => svc.resolveSwitchTarget({ principal: { userId: 'u' }, targetOrganizationId: 'o2' }),
    (e) => e.code === 'NO_ACTIVE_MEMBERSHIP',
  );
});

test('updateProfile refuses when the organization is not ACTIVE', async () => {
  const repo = fakeRepo({ findById: async (id) => ({ id, state: 'SUSPENDED', offboardingAt: null, destructionGraceDays: null, agreementId: 'a' }) });
  const svc = makeService(repo);
  await assert.rejects(
    () => svc.updateProfile({ tenantId: 't', actorUserId: 'u', expectedVersion: 1, changes: { tradingName: 'New' } }),
    (e) => e.code === 'ORGANIZATION_NOT_ACTIVE',
  );
});

test('branding returns the platform default for an unknown host (no enumeration)', async () => {
  const svc = makeService(fakeRepo({ findByHost: async () => null }));
  const b = await svc.getBrandingForHost('unknown.example.com');
  assert.deepEqual(b, { tradingName: 'Abstract ABA', logoUrl: null, accent: '#1172A3' });
});

test('grace window: not elapsed before the configured days, elapsed after', () => {
  const svc = makeService(fakeRepo());
  const now = new Date('2026-02-01T00:00:00Z');
  assert.equal(svc.hasGraceElapsed({ offboardingAt: new Date('2026-01-20T00:00:00Z'), destructionGraceDays: null }, now), false); // 12 days < 30
  assert.equal(svc.hasGraceElapsed({ offboardingAt: new Date('2025-12-01T00:00:00Z'), destructionGraceDays: null }, now), true);  // >30 days
  assert.equal(svc.hasGraceElapsed({ offboardingAt: null, destructionGraceDays: null }, now), false);
});
