import mongoose from 'mongoose';
import { User, Membership, MembershipRole, Role, UserInvitation, Organization } from '../../models/index.js';
import { withTenant, withPlatform } from '../../tenancy/tenantContext.js';
import { AppError } from '../../common/errors/AppError.js';
import { supportsTransactions } from '../../config/db.js';
import { usersError } from './users.errors.js';

/**
 * The eight tenant-facing system roles seeded into every organization. Keys are
 * stable slugs (assignments reference them); Super Admin is absent by design —
 * platform authority never appears in a tenant role.
 */
export const SYSTEM_ROLES = [
  { key: 'owner', name: 'Owner', description: 'Full control of the organization, including ownership and closure.' },
  { key: 'org_admin', name: 'Organization Admin', description: 'Administers staff, roles and organization settings.' },
  { key: 'bcba', name: 'BCBA', description: 'Board Certified Behavior Analyst: supervises clinical work and approves sessions.' },
  { key: 'rbt', name: 'RBT', description: 'Registered Behavior Technician: delivers and records sessions.' },
  { key: 'billing_staff', name: 'Billing Staff', description: 'Manages claims, invoices and payments.' },
  { key: 'scheduler', name: 'Scheduler', description: 'Manages appointments and calendars.' },
  { key: 'payroll_staff', name: 'Payroll Staff', description: 'Manages timesheets and payroll.' },
  { key: 'receptionist', name: 'Receptionist', description: 'Front-desk operations and intake.' },
];

/**
 * Persistence for user & role management (MongoDB/Mongoose). Scope per method
 * mirrors the original port: tenant-owned reads/writes run under withTenant();
 * the single pre-auth token lookup and the global user row run under
 * withPlatform(). Multi-document writes use a transaction when the deployment is
 * a replica set, and a best-effort sequence otherwise (the version guard and
 * unique indexes remain the integrity anchors).
 */
export class UsersRepository {
  async ensureSystemRoles(tenantId) {
    await withTenant(tenantId, async () => {
      for (const role of SYSTEM_ROLES) {
        await Role.updateOne(
          { key: role.key },
          { $setOnInsert: { name: role.name, description: role.description, system: true, assignable: true } },
          { upsert: true },
        );
      }
    });
  }

  async listAssignableRoles(tenantId) {
    return withTenant(tenantId, async () => {
      const roles = await Role.find({ assignable: true }).sort({ name: 1 }).lean();
      return roles.map(toRole);
    });
  }

  async findRolesByKeys(tenantId, keys) {
    return withTenant(tenantId, async () => {
      const roles = await Role.find({ key: { $in: keys } }).lean();
      return roles.map(toRole);
    });
  }

  async listRoleIdsForMembership(tenantId, membershipId) {
    return withTenant(tenantId, async () => {
      const rows = await MembershipRole.find({ membershipId }).select({ roleId: 1 }).lean();
      return rows.map((r) => r.roleId);
    });
  }

  async listMembers(query) {
    return withTenant(query.tenantId, async () => {
      const filter = {};
      if (query.status) filter.status = query.status;
      if (query.cursor) filter._id = { $lt: query.cursor };
      if (query.search) {
        // email/fullName live on the global user row; resolve matching users first.
        const rx = new RegExp(escapeRegExp(query.search), 'i');
        const users = await withPlatform(() =>
          User.find({ $or: [{ email: rx }, { fullName: rx }] }).select({ _id: 1 }).lean(),
        );
        filter.userId = { $in: users.map((u) => u._id) };
      }
      const limit = query.limit ?? 25;
      const rows = await Membership.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items = await this._assembleMembers(query.tenantId, page);
      return { items, nextCursor: hasMore ? page[page.length - 1]._id : null };
    });
  }

  async findMember(tenantId, membershipId) {
    return withTenant(tenantId, async () => {
      const doc = await Membership.findById(membershipId).lean();
      if (!doc) return null;
      const [member] = await this._assembleMembers(tenantId, [doc]);
      return member;
    });
  }

  /**
   * Update a user's canonical login email (spec §7). The email lives ONLY on the
   * global User row — never duplicated onto StaffProfile. Rejects a duplicate
   * (another user already using it) and no-ops when unchanged. Caller has already
   * confirmed the user belongs to the acting tenant (resolved via the tenant-
   * scoped StaffProfile), so this is authorized staff administration.
   */
  async updateUserEmail({ userId, email }) {
    return withPlatform(async () => {
      const current = await User.findById(userId).select({ email: 1 }).lean();
      if (!current) throw AppError.notFound('USER-404', 'User not found');
      if (current.email === email) return { userId, email, changed: false };
      const clash = await User.findOne({ email }).select({ _id: 1 }).lean();
      if (clash && String(clash._id) !== String(userId)) {
        throw AppError.conflict('USER-409', 'That email address is already in use.');
      }
      await User.updateOne({ _id: userId }, { $set: { email } });
      return { userId, email, changed: true };
    });
  }

  async findMembershipByEmail(tenantId, email) {
    const user = await withPlatform(() => User.findOne({ email }).select({ _id: 1 }).lean());
    if (!user) return null;
    return withTenant(tenantId, async () => {
      const m = await Membership.findOne({ userId: user._id }).select({ _id: 1, status: 1 }).lean();
      return m ? { membershipId: m._id, status: m.status } : null;
    });
  }

  async countActiveOwners(tenantId) {
    return withTenant(tenantId, async () => Membership.countDocuments({ isOwner: true, status: 'ACTIVE' }));
  }

  async inviteMember(input) {
    await this._maybeTx(async (session) => {
      // Global user row (platform-scoped, no plugin): reuse if the email already
      // has an account, otherwise create it.
      await withPlatform(async () => {
        const existing = await User.findOne({ email: input.email }).select({ _id: 1 }).session(session).lean();
        if (existing) {
          input.userId = existing._id;
        } else {
          await User.create(
            [{ _id: input.userId, email: input.email, fullName: input.fullName, status: 'ACTIVE', passwordHash: null, permissionsVersion: 1 }],
            session ? { session } : {},
          );
        }
      });
      await withTenant(input.tenantId, async () => {
        await Membership.create(
          [{ _id: input.membershipId, userId: input.userId, status: 'INVITED', isOwner: input.isOwner, createdBy: input.invitedByUserId }],
          session ? { session } : {},
        );
        if (input.roleIds.length > 0) {
          await MembershipRole.create(
            input.roleIds.map((roleId) => ({ membershipId: input.membershipId, roleId, assignedBy: input.invitedByUserId })),
            session ? { session } : {},
          );
        }
        await UserInvitation.create(
          [{ _id: input.invitationId, membershipId: input.membershipId, email: input.email, tokenHash: input.tokenHash, expiresAt: input.expiresAt, invitedByUserId: input.invitedByUserId }],
          session ? { session } : {},
        );
      });
    });

    const member = await this.findMember(input.tenantId, input.membershipId);
    const invitation = await this.findInvitation(input.tenantId, input.invitationId);
    return { member, invitation };
  }

  async findInvitation(tenantId, invitationId) {
    return withTenant(tenantId, async () => {
      const doc = await UserInvitation.findById(invitationId).lean();
      return doc ? toInvitation(doc, tenantId) : null;
    });
  }

  async findInvitationByTokenHash(tokenHash) {
    // Pre-authentication: the token is the authorization, so this spans tenants.
    return withPlatform(async () => {
      const invitation = await UserInvitation.findOne({ tokenHash }).lean();
      if (!invitation) return null;
      const membership = await Membership.findById(invitation.membershipId).lean();
      if (!membership) return null;
      const user = await User.findById(membership.userId).select({ fullName: 1, passwordHash: 1 }).lean();
      const org = await Organization.findById(membership.tenantId).select({ tradingName: 1 }).lean();
      if (!user || !org) return null;
      return {
        invitation: toInvitation(invitation, membership.tenantId),
        userId: membership.userId,
        userHasPassword: user.passwordHash !== null && user.passwordHash !== undefined,
        userFullName: user.fullName,
        organizationTradingName: org.tradingName,
      };
    });
  }

  async resendInvitation(input) {
    return withTenant(input.tenantId, async () => {
      const updated = await UserInvitation.findOneAndUpdate(
        { _id: input.invitationId, acceptedAt: null, revokedAt: null },
        { $set: { tokenHash: input.tokenHash, expiresAt: input.expiresAt } },
        { new: true },
      ).lean();
      if (!updated) throw usersError('INVITATION_INVALID', { message: 'That invitation is no longer pending.' });
      return toInvitation(updated, input.tenantId);
    });
  }

  async revokeInvitation(input) {
    await this._maybeTx(async (session) => {
      await withTenant(input.tenantId, async () => {
        await UserInvitation.updateOne({ _id: input.invitationId }, { $set: { revokedAt: new Date() } }, session ? { session } : {});
        await MembershipRole.deleteMany({ membershipId: input.membershipId }, session ? { session } : {});
        await Membership.deleteOne({ _id: input.membershipId }, session ? { session } : {});
      });
    });
  }

  /**
   * Creates the first (owner) account for a brand-new tenant: the global user
   * row with its password already set (no separate accept step — the company
   * invitation flow collects the password in the same submission that creates
   * the organization), the 'owner' system role seeded, and an ACTIVE, isOwner
   * membership linking the two. Mirrors inviteMember/acceptInvitation but
   * collapses them into one step since there is no pre-existing tenant to
   * invite a stranger into.
   */
  async createOwnerAccount(input) {
    return this.createActiveAccountWithPassword({ ...input, isOwner: true, roleKey: 'owner' });
  }

  /**
   * Creates (or reuses) an ACTIVE user with a password already set and an
   * ACTIVE membership under one role, in one tenant. `createOwnerAccount`
   * above is this with the owner role/flag pinned; the seed script uses this
   * directly to create BCBA/RBT demo accounts under the same tenant with a
   * non-owner role, without duplicating the account-creation logic.
   */
  async createActiveAccountWithPassword({ userId, membershipId, tenantId, email, fullName, passwordHash, roleKey, isOwner = false }) {
    await this._maybeTx(async (session) => {
      await withPlatform(async () => {
        const existing = await User.findOne({ email }).session(session).lean();
        if (existing) {
          userId = existing._id;
          await User.updateOne(
            { _id: existing._id },
            { $set: { passwordHash, fullName, emailVerifiedAt: new Date(), passwordUpdatedAt: new Date(), status: 'ACTIVE' } },
            session ? { session } : {},
          );
        } else {
          await User.create(
            [{
              _id: userId,
              email,
              fullName,
              status: 'ACTIVE',
              passwordHash,
              emailVerifiedAt: new Date(),
              passwordUpdatedAt: new Date(),
              permissionsVersion: 1,
            }],
            session ? { session } : {},
          );
        }
      });
      await withTenant(tenantId, async () => {
        for (const role of SYSTEM_ROLES) {
          await Role.updateOne(
            { key: role.key },
            { $setOnInsert: { name: role.name, description: role.description, system: true, assignable: true } },
            { upsert: true, session: session ?? undefined },
          );
        }
        const role = await Role.findOne({ key: roleKey }).session(session).lean();
        // tenantId is never taken from arbitrary caller input in the sense that
        // matters — it is always the withTenant() context value, which both
        // call sites (the invitation-accept flow and the seed script) derive
        // from the organization's own _id, never from a request body field.
        const existingMembership = await Membership.findOne({ userId }).session(session).lean();
        if (existingMembership) {
          membershipId = existingMembership._id;
          await Membership.updateOne(
            { _id: existingMembership._id },
            { $set: { status: 'ACTIVE', isOwner, joinedAt: existingMembership.joinedAt ?? new Date() } },
            session ? { session } : {},
          );
          await MembershipRole.deleteMany({ membershipId: existingMembership._id }, session ? { session } : {});
        } else {
          await Membership.create(
            [{ _id: membershipId, userId, status: 'ACTIVE', isOwner, joinedAt: new Date(), createdBy: userId }],
            session ? { session } : {},
          );
        }
        if (role) {
          await MembershipRole.create(
            [{ membershipId, roleId: role._id, assignedBy: userId }],
            session ? { session } : {},
          );
        }
      });
    });
    return this.findMember(tenantId, membershipId);
  }

  /**
   * Provision a brand-new staff account with a server-generated TEMPORARY
   * password already hashed and set. The member can sign in immediately with the
   * temp password and is forced to change it on first login (mustChangePassword).
   * A genuinely new email is required: if a global user already exists for this
   * email the whole operation is rejected (DUPLICATE_STAFF_EMAIL) BEFORE any
   * write, so we never hijack an existing identity, never overwrite a password,
   * and never orphan a StaffProfile. No UserInvitation row is created — the temp
   * password is the delivery, reusing the same account+membership+role primitive
   * the owner-onboarding path uses (no second invitation/password system).
   */
  async provisionStaffAccount({ userId, membershipId, tenantId, email, fullName, passwordHash, roleKey, actorUserId }) {
    const normalizedEmail = String(email).toLowerCase().trim();
    await this._maybeTx(async (session) => {
      await withPlatform(async () => {
        const existing = await User.findOne({ email: normalizedEmail }).select({ _id: 1 }).session(session).lean();
        if (existing) throw usersError('DUPLICATE_STAFF_EMAIL');
        await User.create(
          [{
            _id: userId,
            email: normalizedEmail,
            fullName,
            status: 'ACTIVE',
            passwordHash,
            mustChangePassword: true,
            firstLoginAt: null,
            emailVerifiedAt: null,
            passwordUpdatedAt: new Date(),
            permissionsVersion: 1,
          }],
          session ? { session } : {},
        );
      });
      await withTenant(tenantId, async () => {
        for (const role of SYSTEM_ROLES) {
          await Role.updateOne(
            { key: role.key },
            { $setOnInsert: { name: role.name, description: role.description, system: true, assignable: true } },
            { upsert: true, session: session ?? undefined },
          );
        }
        const role = await Role.findOne({ key: roleKey }).session(session).lean();
        await Membership.create(
          [{ _id: membershipId, userId, status: 'ACTIVE', isOwner: false, joinedAt: new Date(), createdBy: actorUserId ?? userId }],
          session ? { session } : {},
        );
        if (role) {
          await MembershipRole.create(
            [{ membershipId, roleId: role._id, assignedBy: actorUserId ?? userId }],
            session ? { session } : {},
          );
        }
      });
    });
    return { userId, membershipId };
  }

  /**
   * Resend/rotate a staff member's temporary login credential (Resend Login
   * Email). Only valid BEFORE the member has completed first login — the caller
   * (service) enforces that gate against the safe account view. This rotates the
   * temp password hash and re-arms mustChangePassword, invalidating the previous
   * temp password so an old, undelivered credential cannot still be used. It also
   * clears any lockout so a re-invited member is not accidentally locked out.
   * Never stores/returns/logs the plaintext (the caller passes only the hash).
   */
  async rotateStaffTempPassword({ userId, passwordHash }) {
    await withPlatform(async () => {
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            passwordHash,
            mustChangePassword: true,
            firstLoginAt: null,
            passwordUpdatedAt: new Date(),
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
        },
      );
    });
  }

  /**
   * Safe account/login metadata for a staff member, joined from the global User
   * (platform-scoped) and their tenant Membership. Returns ONLY non-secret
   * fields — login email, statuses, first-login/last-login timestamps, role
   * keys. Never returns passwordHash, reset/invitation tokens, or any secret.
   */
  async findStaffAccountByUserId(tenantId, userId) {
    const user = await withPlatform(async () =>
      User.findById(userId)
        .select({ email: 1, status: 1, mustChangePassword: 1, firstLoginAt: 1, lastLoginAt: 1 })
        .lean());
    if (!user) return null;
    return withTenant(tenantId, async () => {
      const membership = await Membership.findOne({ userId }).select({ _id: 1, status: 1 }).lean();
      if (!membership) return null;
      const links = await MembershipRole.find({ membershipId: membership._id }).select({ roleId: 1 }).lean();
      const roles = links.length
        ? await Role.find({ _id: { $in: links.map((l) => l.roleId) } }).select({ key: 1 }).lean()
        : [];
      return {
        loginEmail: user.email,
        userId,
        membershipId: membership._id,
        accountStatus: user.status,
        membershipStatus: membership.status,
        roleKeys: roles.map((r) => r.key),
        firstLoginCompleted: user.mustChangePassword === false,
        firstLoginAt: user.firstLoginAt ?? null,
        lastLoginAt: user.lastLoginAt ?? null,
      };
    });
  }

  async acceptInvitation(input) {
    await this._maybeTx(async (session) => {
      await withPlatform(async () => {
        await User.updateOne(
          { _id: input.userId },
          { $set: { passwordHash: input.passwordHash, emailVerifiedAt: new Date(), passwordUpdatedAt: new Date(), ...(input.fullName ? { fullName: input.fullName } : {}) } },
          session ? { session } : {},
        );
      });
      await withTenant(input.tenantId, async () => {
        await Membership.updateOne(
          { _id: input.membershipId },
          { $set: { status: 'ACTIVE', joinedAt: new Date() }, $inc: { version: 1 } },
          session ? { session } : {},
        );
        await UserInvitation.updateOne({ _id: input.invitationId }, { $set: { acceptedAt: new Date() } }, session ? { session } : {});
      });
    });
    return this.findMember(input.tenantId, input.membershipId);
  }

  async setMembershipStatus(input) {
    return withTenant(input.tenantId, async () => {
      const updated = await Membership.findOneAndUpdate(
        { _id: input.membershipId, version: input.expectedVersion },
        { $set: { status: input.status, updatedBy: input.actorUserId }, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (!updated) {
        const exists = await Membership.exists({ _id: input.membershipId });
        throw exists
          ? usersError('MEMBERSHIP_STATUS_INVALID', { message: 'The record changed since you read it; reload and retry.' })
          : usersError('TENANT_RESOURCE_NOT_FOUND');
      }
      const [member] = await this._assembleMembers(input.tenantId, [updated]);
      return member;
    });
  }

  async assignRoles(input) {
    await this._maybeTx(async (session) => {
      await withTenant(input.tenantId, async () => {
        for (const roleId of input.roleIds) {
          await MembershipRole.updateOne(
            { membershipId: input.membershipId, roleId },
            { $setOnInsert: { assignedBy: input.actorUserId, assignedAt: new Date() } },
            { upsert: true, ...(session ? { session } : {}) },
          );
        }
        if (input.grantsOwnership) {
          await Membership.updateOne(
            { _id: input.membershipId },
            { $set: { isOwner: true, updatedBy: input.actorUserId }, $inc: { version: 1 } },
            session ? { session } : {},
          );
        }
      });
    });
    return this.findMember(input.tenantId, input.membershipId);
  }

  async unassignRole(input) {
    await this._maybeTx(async (session) => {
      await withTenant(input.tenantId, async () => {
        await MembershipRole.deleteOne({ membershipId: input.membershipId, roleId: input.roleId }, session ? { session } : {});
        if (input.revokesOwnership) {
          await Membership.updateOne(
            { _id: input.membershipId },
            { $set: { isOwner: false, updatedBy: input.actorUserId }, $inc: { version: 1 } },
            session ? { session } : {},
          );
        }
      });
    });
    return this.findMember(input.tenantId, input.membershipId);
  }

  // --- helpers --------------------------------------------------------------

  /** Joins a page of membership docs with their user rows and roles → Member[]. */
  async _assembleMembers(tenantId, membershipDocs) {
    if (membershipDocs.length === 0) return [];
    const userIds = [...new Set(membershipDocs.map((m) => m.userId))];
    const membershipIds = membershipDocs.map((m) => m._id);

    const users = await withPlatform(() =>
      User.find({ _id: { $in: userIds } })
        .select({ email: 1, fullName: 1, status: 1, lastLoginAt: 1 })
        .lean(),
    );
    const userById = new Map(users.map((u) => [u._id, u]));

    const assignments = await MembershipRole.find({ membershipId: { $in: membershipIds } }).lean();
    const roleIds = [...new Set(assignments.map((a) => a.roleId))];
    const roles = await Role.find({ _id: { $in: roleIds } }).lean();
    const roleById = new Map(roles.map((r) => [r._id, r]));
    const rolesByMembership = new Map();
    for (const a of assignments) {
      const role = roleById.get(a.roleId);
      if (!role) continue;
      const list = rolesByMembership.get(a.membershipId) ?? [];
      list.push({ id: role._id, key: role.key, name: role.name, description: role.description ?? null });
      rolesByMembership.set(a.membershipId, list);
    }

    return membershipDocs.map((m) => {
      const user = userById.get(m.userId) ?? {};
      return {
        membershipId: m._id,
        tenantId,
        userId: m.userId,
        email: user.email ?? null,
        fullName: user.fullName ?? null,
        status: m.status,
        isOwner: !!m.isOwner,
        userStatus: user.status ?? 'ACTIVE',
        joinedAt: m.joinedAt ?? null,
        lastLoginAt: user.lastLoginAt ?? null,
        roles: rolesByMembership.get(m._id) ?? [],
        createdAt: m.createdAt ?? null,
        version: m.version ?? 1,
      };
    });
  }

  /** Runs `fn(session)` in a transaction when the deployment supports one. */
  async _maybeTx(fn) {
    if (!supportsTransactions()) return fn(null);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => { await fn(session); });
    } finally {
      await session.endSession();
    }
  }
}

function toRole(doc) {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    key: doc.key,
    name: doc.name,
    description: doc.description ?? null,
    system: !!doc.system,
    assignable: !!doc.assignable,
  };
}

function toInvitation(doc, tenantId) {
  return {
    id: doc._id,
    tenantId: doc.tenantId ?? tenantId,
    membershipId: doc.membershipId,
    email: doc.email,
    expiresAt: doc.expiresAt,
    acceptedAt: doc.acceptedAt ?? null,
    revokedAt: doc.revokedAt ?? null,
    invitedByUserId: doc.invitedByUserId,
    createdAt: doc.createdAt ?? null,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const usersRepository = new UsersRepository();
