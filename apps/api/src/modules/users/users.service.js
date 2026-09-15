import { usersError } from './users.errors.js';

/** The one role key that carries organization ownership. */
export const OWNER_ROLE_KEY = 'owner';

/** Statuses reachable through the membership-status endpoint. */
const STATUS_ENDPOINT_TARGETS = ['ACTIVE', 'SUSPENDED'];

/**
 * User and role management (Module 4), ported from the original UsersService.
 * Holds the rules; the repository holds data access. Two invariants run through
 * almost every method:
 *   - An organization always retains at least one active owner (E-14).
 *   - A change to what a member can do invalidates their tokens immediately (E-3).
 *
 * Dependencies (ports) are injected so the rules are testable without a database:
 *   repository, newId, passwords{assertAcceptable,hash}, tokens{issue,hash},
 *   tokenInvalidator{invalidate}, organizations{getById}, invitationTtlHours.
 */
export class UsersService {
  constructor(deps) {
    this.deps = deps;
  }

  // --- roles ----------------------------------------------------------------

  async listAssignableRoles(tenantId) {
    await this.deps.repository.ensureSystemRoles(tenantId);
    const roles = await this.deps.repository.listAssignableRoles(tenantId);
    return roles.map(UsersService.toRoleSummary);
  }

  // --- reading members ------------------------------------------------------

  listMembers(query) {
    return this.deps.repository.listMembers(query);
  }

  async getMember(tenantId, membershipId) {
    const member = await this.deps.repository.findMember(tenantId, membershipId);
    // A member id from another tenant yields NOT_FOUND, never FORBIDDEN (S-4).
    if (!member) throw usersError('TENANT_RESOURCE_NOT_FOUND');
    return member;
  }

  // --- inviting -------------------------------------------------------------

  async inviteMember(input) {
    const email = input.email.trim().toLowerCase();
    const { roles, grantsOwnership } = await this.resolveAssignableRoles(input.tenantId, input.roleKeys);

    const existing = await this.deps.repository.findMembershipByEmail(input.tenantId, email);
    if (existing) {
      throw usersError('USER_ALREADY_MEMBER', {
        message:
          existing.status === 'REMOVED'
            ? 'That person was previously removed from this organization.'
            : 'That person is already a member of this organization.',
        context: { status: existing.status },
      });
    }

    const { token, tokenHash } = this.deps.tokens.issue();
    const { member, invitation } = await this.deps.repository.inviteMember({
      tenantId: input.tenantId,
      userId: this.deps.newId(),
      membershipId: this.deps.newId(),
      invitationId: this.deps.newId(),
      email,
      fullName: input.fullName.trim(),
      roleIds: roles.map((r) => r.id),
      isOwner: grantsOwnership,
      tokenHash,
      expiresAt: this.invitationExpiry(),
      invitedByUserId: input.invitedByUserId,
    });
    return { member, invitation, token };
  }

  /** The platform-authority bootstrap: invites the first owner of an org. */
  async inviteInitialOwner(input) {
    const organization = await this.deps.organizations.getById(input.organizationId);
    if (organization.state === 'DESTROYED' || organization.state === 'OFFBOARDING') {
      throw usersError('ILLEGAL_STATE_TRANSITION', {
        message: 'An owner cannot be invited to an organization that is closing or closed.',
        context: { state: organization.state },
      });
    }
    return this.inviteMember({
      tenantId: input.organizationId,
      email: input.email,
      fullName: input.fullName,
      roleKeys: [OWNER_ROLE_KEY],
      invitedByUserId: input.invitedByUserId,
    });
  }

  async resendInvitation(input) {
    const invitation = await this.requirePendingInvitation(input.tenantId, input.invitationId);
    const { token, tokenHash } = this.deps.tokens.issue();
    const updated = await this.deps.repository.resendInvitation({
      tenantId: input.tenantId,
      invitationId: invitation.id,
      tokenHash,
      expiresAt: this.invitationExpiry(),
    });
    return { invitation: updated, token };
  }

  async revokeInvitation(input) {
    const invitation = await this.deps.repository.findInvitation(input.tenantId, input.invitationId);
    if (!invitation) throw usersError('TENANT_RESOURCE_NOT_FOUND');
    if (invitation.revokedAt !== null) return; // idempotent
    if (invitation.acceptedAt !== null) {
      throw usersError('INVITATION_INVALID', {
        message: 'That invitation was already accepted. Remove the member instead.',
      });
    }
    await this.deps.repository.revokeInvitation({
      tenantId: input.tenantId,
      invitationId: invitation.id,
      membershipId: invitation.membershipId,
      actorUserId: input.actorUserId,
    });
  }

  // --- accepting (public) ---------------------------------------------------

  async previewInvitation(token) {
    const resolved = await this.resolveUsableInvitation(token);
    return {
      organizationTradingName: resolved.organizationTradingName,
      email: resolved.invitation.email,
      fullName: resolved.userFullName,
      requiresPassword: !resolved.userHasPassword,
      expiresAt: resolved.invitation.expiresAt,
    };
  }

  async acceptInvitation(input) {
    const resolved = await this.resolveUsableInvitation(input.token);
    const fullName = input.fullName?.trim();
    this.deps.passwords.assertAcceptable(input.password, {
      email: resolved.invitation.email,
      ...(fullName ? { fullName } : {}),
    });
    const passwordHash = await this.deps.passwords.hash(input.password);
    return this.deps.repository.acceptInvitation({
      tenantId: resolved.invitation.tenantId,
      invitationId: resolved.invitation.id,
      membershipId: resolved.invitation.membershipId,
      userId: resolved.userId,
      passwordHash,
      fullName: fullName ?? null,
    });
  }

  // --- membership status ----------------------------------------------------

  async setMembershipStatus(input) {
    if (!STATUS_ENDPOINT_TARGETS.includes(input.status)) {
      throw usersError('MEMBERSHIP_STATUS_INVALID', {
        message: 'A membership can only be suspended or reactivated here.',
        context: { status: input.status },
      });
    }
    const member = await this.getMember(input.tenantId, input.membershipId);
    this.assertNotSelf(member, input.actorUserId);

    if (member.status === 'INVITED' || member.status === 'REMOVED') {
      throw usersError('MEMBERSHIP_STATUS_INVALID', {
        message: `A ${member.status.toLowerCase()} membership cannot change status this way.`,
        context: { from: member.status, to: input.status },
      });
    }
    if (member.status === input.status) return member; // idempotent
    if (input.status === 'SUSPENDED') await this.assertOwnerInvariantHolds(member);

    const updated = await this.deps.repository.setMembershipStatus({
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      status: input.status,
      expectedVersion: input.expectedVersion,
      actorUserId: input.actorUserId,
    });
    await this.deps.tokenInvalidator.invalidate(member.userId);
    return updated;
  }

  async removeMember(input) {
    const member = await this.getMember(input.tenantId, input.membershipId);
    this.assertNotSelf(member, input.actorUserId);
    if (member.status === 'REMOVED') return; // idempotent
    await this.assertOwnerInvariantHolds(member);
    await this.deps.repository.setMembershipStatus({
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      status: 'REMOVED',
      expectedVersion: input.expectedVersion,
      actorUserId: input.actorUserId,
    });
    await this.deps.tokenInvalidator.invalidate(member.userId);
  }

  // --- role assignment ------------------------------------------------------

  async assignRoles(input) {
    const { roles, grantsOwnership } = await this.resolveAssignableRoles(input.tenantId, input.roleKeys);
    const member = await this.getMember(input.tenantId, input.membershipId);
    if (member.status === 'REMOVED') {
      throw usersError('MEMBERSHIP_STATUS_INVALID', { message: 'Roles cannot be assigned to a removed member.' });
    }
    const updated = await this.deps.repository.assignRoles({
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      roleIds: roles.map((r) => r.id),
      grantsOwnership,
      actorUserId: input.actorUserId,
    });
    await this.deps.tokenInvalidator.invalidate(member.userId);
    return updated;
  }

  async unassignRole(input) {
    await this.deps.repository.ensureSystemRoles(input.tenantId);
    const [role] = await this.deps.repository.findRolesByKeys(input.tenantId, [input.roleKey]);
    if (!role) throw usersError('ROLE_NOT_FOUND', { context: { roleKey: input.roleKey } });

    const member = await this.getMember(input.tenantId, input.membershipId);
    const revokesOwnership = role.key === OWNER_ROLE_KEY;

    if (revokesOwnership) {
      if (member.userId === input.actorUserId) {
        throw usersError('SELF_MEMBERSHIP_MODIFICATION', { message: 'You cannot remove your own ownership.' });
      }
      await this.assertOwnerInvariantHolds(member);
    }
    if (!member.roles.some((assigned) => assigned.id === role.id)) return member; // idempotent

    const updated = await this.deps.repository.unassignRole({
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      roleId: role.id,
      revokesOwnership,
      actorUserId: input.actorUserId,
    });
    await this.deps.tokenInvalidator.invalidate(member.userId);
    return updated;
  }

  resolveMembershipRoleIds(tenantId, membershipId) {
    return this.deps.repository.listRoleIdsForMembership(tenantId, membershipId);
  }

  // --- helpers --------------------------------------------------------------

  assertNotSelf(member, actorUserId) {
    if (member.userId === actorUserId) {
      throw usersError('SELF_MEMBERSHIP_MODIFICATION', { message: 'You cannot change your own membership.' });
    }
  }

  async assertOwnerInvariantHolds(member) {
    if (!(member.isOwner && member.status === 'ACTIVE')) return;
    const activeOwners = await this.deps.repository.countActiveOwners(member.tenantId);
    if (activeOwners <= 1) {
      throw usersError('LAST_ACTIVE_OWNER', { message: 'An organization must keep at least one active owner.' });
    }
  }

  async resolveAssignableRoles(tenantId, roleKeys) {
    await this.deps.repository.ensureSystemRoles(tenantId);
    const requested = [...new Set(roleKeys.map((k) => k.trim().toLowerCase()))];
    const roles = await this.deps.repository.findRolesByKeys(tenantId, requested);

    const found = new Set(roles.map((r) => r.key));
    const missing = requested.filter((k) => !found.has(k));
    if (missing.length > 0) throw usersError('ROLE_NOT_FOUND', { context: { roleKeys: missing } });

    const unassignable = roles.filter((r) => !r.assignable);
    if (unassignable.length > 0) {
      throw usersError('ROLE_NOT_ASSIGNABLE', { context: { roleKeys: unassignable.map((r) => r.key) } });
    }
    return { roles, grantsOwnership: found.has(OWNER_ROLE_KEY) };
  }

  async requirePendingInvitation(tenantId, invitationId) {
    const invitation = await this.deps.repository.findInvitation(tenantId, invitationId);
    if (!invitation) throw usersError('TENANT_RESOURCE_NOT_FOUND');
    if (invitation.acceptedAt !== null || invitation.revokedAt !== null) {
      throw usersError('INVITATION_INVALID', { message: 'That invitation is no longer pending.' });
    }
    return invitation;
  }

  /** Unknown, expired, revoked and already-accepted all fail identically (no oracle). */
  async resolveUsableInvitation(token) {
    const tokenHash = this.deps.tokens.hash(token);
    const resolved = await this.deps.repository.findInvitationByTokenHash(tokenHash);
    const usable =
      resolved !== null &&
      resolved.invitation.revokedAt === null &&
      resolved.invitation.acceptedAt === null &&
      new Date(resolved.invitation.expiresAt).getTime() > Date.now();
    if (!usable) throw usersError('INVITATION_INVALID');
    return resolved;
  }

  invitationExpiry() {
    return new Date(Date.now() + this.deps.invitationTtlHours * 60 * 60 * 1000);
  }

  static toRoleSummary(role) {
    return { id: role.id, key: role.key, name: role.name, description: role.description };
  }
}
