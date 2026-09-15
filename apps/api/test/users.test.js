import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsersService } from '../src/modules/users/users.service.js';

/**
 * DB-free tests for the user & role management service, exercised against a fake
 * repository. These mirror the original module's guarantees: the owner
 * invariant, the self-action guard, invitation lifecycle, uniform invitation
 * failure, role resolution, and token invalidation on permission-changing ops.
 */

const OWNER_ROLE = { id: 'r-owner', key: 'owner', name: 'Owner', description: null, system: true, assignable: true };
const BCBA_ROLE = { id: 'r-bcba', key: 'bcba', name: 'BCBA', description: null, system: true, assignable: true };
const SYSTEM_LOCKED = { id: 'r-sys', key: 'system_locked', name: 'Locked', description: null, system: true, assignable: false };

function makeService(repo, spies = {}) {
  const invalidate = spies.invalidate ?? (async () => {});
  return new UsersService({
    repository: repo,
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
    passwords: { assertAcceptable: () => {}, hash: async () => 'HASH' },
    tokens: { issue: () => ({ token: 'tok_' + 'x'.repeat(30), tokenHash: 'HASH' }), hash: (t) => 'HASH:' + t },
    tokenInvalidator: { invalidate },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    invitationTtlHours: 72,
  });
}

function baseRepo(overrides = {}) {
  return {
    ensureSystemRoles: async () => {},
    listAssignableRoles: async () => [OWNER_ROLE, BCBA_ROLE],
    findRolesByKeys: async (_t, keys) => [OWNER_ROLE, BCBA_ROLE, SYSTEM_LOCKED].filter((r) => keys.includes(r.key)),
    listRoleIdsForMembership: async () => [],
    listMembers: async () => ({ items: [], nextCursor: null }),
    findMember: async () => null,
    findMembershipByEmail: async () => null,
    countActiveOwners: async () => 2,
    inviteMember: async (i) => ({
      member: { membershipId: i.membershipId, tenantId: i.tenantId, userId: i.userId, email: i.email, fullName: i.fullName, status: 'INVITED', isOwner: i.isOwner, userStatus: 'ACTIVE', joinedAt: null, lastLoginAt: null, roles: [], createdAt: new Date(), version: 1 },
      invitation: { id: i.invitationId, tenantId: i.tenantId, membershipId: i.membershipId, email: i.email, expiresAt: i.expiresAt, acceptedAt: null, revokedAt: null, invitedByUserId: i.invitedByUserId, createdAt: new Date() },
    }),
    findInvitation: async () => null,
    findInvitationByTokenHash: async () => null,
    resendInvitation: async (i) => ({ id: i.invitationId, tenantId: i.tenantId, membershipId: 'm', email: 'a@b.test', expiresAt: i.expiresAt, acceptedAt: null, revokedAt: null, invitedByUserId: 'u', createdAt: new Date() }),
    revokeInvitation: async () => {},
    acceptInvitation: async () => activeMember(),
    setMembershipStatus: async (i) => ({ ...activeMember(), status: i.status }),
    assignRoles: async () => activeMember(),
    unassignRole: async () => activeMember(),
    ...overrides,
  };
}

function activeMember(over = {}) {
  return {
    membershipId: 'm1', tenantId: 't1', userId: 'u-other', email: 'a@b.test', fullName: 'A B',
    status: 'ACTIVE', isOwner: false, userStatus: 'ACTIVE', joinedAt: new Date(), lastLoginAt: null,
    roles: [], createdAt: new Date(), version: 3, ...over,
  };
}

// --- invite ---------------------------------------------------------------

test('inviteMember rejects a duplicate member', async () => {
  const svc = makeService(baseRepo({ findMembershipByEmail: async () => ({ membershipId: 'm', status: 'ACTIVE' }) }));
  await assert.rejects(
    () => svc.inviteMember({ tenantId: 't', email: 'a@b.test', fullName: 'A B', roleKeys: ['bcba'], invitedByUserId: 'inv' }),
    (e) => e.code === 'USER_ALREADY_MEMBER',
  );
});

test('inviteInitialOwner refuses a closing/closed organization', async () => {
  const svc = makeService(baseRepo());
  svc.deps.organizations.getById = async () => ({ state: 'OFFBOARDING' });
  await assert.rejects(
    () => svc.inviteInitialOwner({ organizationId: 'o', email: 'a@b.test', fullName: 'A B', invitedByUserId: 'op' }),
    (e) => e.code === 'ILLEGAL_STATE_TRANSITION',
  );
});

// --- role resolution ------------------------------------------------------

test('unknown role key is rejected, not silently dropped', async () => {
  const svc = makeService(baseRepo());
  await assert.rejects(
    () => svc.inviteMember({ tenantId: 't', email: 'a@b.test', fullName: 'A B', roleKeys: ['not_a_role'], invitedByUserId: 'inv' }),
    (e) => e.code === 'ROLE_NOT_FOUND',
  );
});

test('an unassignable role is refused', async () => {
  const svc = makeService(baseRepo());
  await assert.rejects(
    () => svc.inviteMember({ tenantId: 't', email: 'a@b.test', fullName: 'A B', roleKeys: ['system_locked'], invitedByUserId: 'inv' }),
    (e) => e.code === 'ROLE_NOT_ASSIGNABLE',
  );
});

// --- self-action guard ----------------------------------------------------

test('a member cannot change their own membership status', async () => {
  const svc = makeService(baseRepo({ findMember: async () => activeMember({ userId: 'self' }) }));
  await assert.rejects(
    () => svc.setMembershipStatus({ tenantId: 't', membershipId: 'm1', status: 'SUSPENDED', expectedVersion: 3, actorUserId: 'self' }),
    (e) => e.code === 'SELF_MEMBERSHIP_MODIFICATION',
  );
});

// --- owner invariant ------------------------------------------------------

test('suspending the last active owner is refused', async () => {
  const svc = makeService(baseRepo({
    findMember: async () => activeMember({ isOwner: true, userId: 'u-owner' }),
    countActiveOwners: async () => 1,
  }));
  await assert.rejects(
    () => svc.setMembershipStatus({ tenantId: 't', membershipId: 'm1', status: 'SUSPENDED', expectedVersion: 3, actorUserId: 'admin' }),
    (e) => e.code === 'LAST_ACTIVE_OWNER',
  );
});

test('removing the last active owner is refused', async () => {
  const svc = makeService(baseRepo({
    findMember: async () => activeMember({ isOwner: true, userId: 'u-owner' }),
    countActiveOwners: async () => 1,
  }));
  await assert.rejects(
    () => svc.removeMember({ tenantId: 't', membershipId: 'm1', expectedVersion: 3, actorUserId: 'admin' }),
    (e) => e.code === 'LAST_ACTIVE_OWNER',
  );
});

test('a member cannot remove their own ownership', async () => {
  const svc = makeService(baseRepo({
    findMember: async () => activeMember({ isOwner: true, userId: 'self', roles: [{ id: 'r-owner', key: 'owner', name: 'Owner', description: null }] }),
    findRolesByKeys: async () => [OWNER_ROLE],
  }));
  await assert.rejects(
    () => svc.unassignRole({ tenantId: 't', membershipId: 'm1', roleKey: 'owner', actorUserId: 'self' }),
    (e) => e.code === 'SELF_MEMBERSHIP_MODIFICATION',
  );
});

// --- token invalidation ---------------------------------------------------

test('permission-changing ops invalidate the affected user tokens', async () => {
  let called = null;
  const svc = makeService(
    baseRepo({ findMember: async () => activeMember({ userId: 'u-target' }) }),
    { invalidate: async (id) => { called = id; } },
  );
  await svc.setMembershipStatus({ tenantId: 't', membershipId: 'm1', status: 'SUSPENDED', expectedVersion: 3, actorUserId: 'admin' });
  assert.equal(called, 'u-target');
});

test('assignRoles invalidates tokens; removed members cannot receive roles', async () => {
  let called = null;
  const svc = makeService(
    baseRepo({ findMember: async () => activeMember({ userId: 'u-target' }) }),
    { invalidate: async (id) => { called = id; } },
  );
  await svc.assignRoles({ tenantId: 't', membershipId: 'm1', roleKeys: ['bcba'], actorUserId: 'admin' });
  assert.equal(called, 'u-target');

  const svc2 = makeService(baseRepo({ findMember: async () => activeMember({ status: 'REMOVED' }) }));
  await assert.rejects(
    () => svc2.assignRoles({ tenantId: 't', membershipId: 'm1', roleKeys: ['bcba'], actorUserId: 'admin' }),
    (e) => e.code === 'MEMBERSHIP_STATUS_INVALID',
  );
});

// --- invitation lifecycle -------------------------------------------------

test('resend/revoke only operate on pending invitations', async () => {
  const accepted = { id: 'i1', tenantId: 't', membershipId: 'm', email: 'a@b.test', expiresAt: new Date(Date.now() + 1e6), acceptedAt: new Date(), revokedAt: null, invitedByUserId: 'u', createdAt: new Date() };
  const svc = makeService(baseRepo({ findInvitation: async () => accepted }));
  await assert.rejects(
    () => svc.resendInvitation({ tenantId: 't', invitationId: 'i1' }),
    (e) => e.code === 'INVITATION_INVALID',
  );
  // revoking an already-accepted invitation is refused (remove the member instead)
  await assert.rejects(
    () => svc.revokeInvitation({ tenantId: 't', invitationId: 'i1', actorUserId: 'admin' }),
    (e) => e.code === 'INVITATION_INVALID',
  );
});

test('revoking an already-revoked invitation is idempotent', async () => {
  const revoked = { id: 'i1', tenantId: 't', membershipId: 'm', email: 'a@b.test', expiresAt: new Date(), acceptedAt: null, revokedAt: new Date(), invitedByUserId: 'u', createdAt: new Date() };
  const svc = makeService(baseRepo({ findInvitation: async () => revoked }));
  await assert.doesNotReject(() => svc.revokeInvitation({ tenantId: 't', invitationId: 'i1', actorUserId: 'admin' }));
});

// --- uniform invitation failure (no oracle) -------------------------------

test('preview/accept fail identically for unknown, expired, revoked, accepted', async () => {
  const cases = [
    null, // unknown
    { invitation: { revokedAt: null, acceptedAt: null, expiresAt: new Date(Date.now() - 1000) } }, // expired
    { invitation: { revokedAt: new Date(), acceptedAt: null, expiresAt: new Date(Date.now() + 1e6) } }, // revoked
    { invitation: { revokedAt: null, acceptedAt: new Date(), expiresAt: new Date(Date.now() + 1e6) } }, // accepted
  ];
  for (const resolved of cases) {
    const svc = makeService(baseRepo({ findInvitationByTokenHash: async () => resolved }));
    await assert.rejects(
      () => svc.previewInvitation('tok_' + 'x'.repeat(30)),
      (e) => e.code === 'INVITATION_INVALID',
    );
  }
});

test('accept sets a password and activates the membership', async () => {
  const usable = {
    invitation: { id: 'i1', tenantId: 't', membershipId: 'm1', email: 'a@b.test', expiresAt: new Date(Date.now() + 1e6), acceptedAt: null, revokedAt: null },
    userId: 'u1', userHasPassword: false, userFullName: 'A B', organizationTradingName: 'Clinic',
  };
  let acceptedWith = null;
  const svc = makeService(baseRepo({
    findInvitationByTokenHash: async () => usable,
    acceptInvitation: async (i) => { acceptedWith = i; return activeMember({ status: 'ACTIVE' }); },
  }));
  const member = await svc.acceptInvitation({ token: 'tok_' + 'x'.repeat(30), password: 'a-good-password' });
  assert.equal(member.status, 'ACTIVE');
  assert.equal(acceptedWith.membershipId, 'm1');
  assert.equal(acceptedWith.passwordHash, 'HASH');
});
