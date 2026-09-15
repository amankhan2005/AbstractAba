import mongoose from 'mongoose';
import { toDateOnly } from '../../utils/format.js';
import { StaffProfile, Credential, SupervisionLink, Membership, MembershipRole, Role, User, ClientAssignment, Client } from '../../models/index.js';
import { withTenant, withPlatform } from '../../tenancy/tenantContext.js';
import { supportsTransactions } from '../../config/db.js';
import { staffError } from './staff.errors.js';
import { scopeToStaff } from '../rbac/scopeFilters.js';

/**
 * Persistence for the staff & credentials module. Every tenant-owned operation
 * runs under withTenant(); the tenant plugin stamps and scopes each one and
 * fails closed without a context. Staff data is PII (no PHI seam). Multi-document
 * writes use the same _maybeTx wrapper the other modules use.
 */
export class StaffRepository {
  // --- staff ---------------------------------------------------------------

  /**
   * Generate a unique, human-readable Employee ID within the tenant (spec §6).
   * Server-only: `EMP-#####` seeded from the current staff count and advanced
   * on collision, so concurrent creates can't duplicate. Never called from React.
   */
  async nextEmployeeNumber(tenantId) {
    return withTenant(tenantId, async () => {
      const base = await StaffProfile.countDocuments({});
      for (let i = 0; i < 50; i += 1) {
        const candidate = `EMP-${String(base + 1 + i).padStart(5, '0')}`;
        const clash = await StaffProfile.findOne({ employeeNumber: candidate }).select({ _id: 1 }).lean();
        if (!clash) return candidate;
      }
      // Extremely unlikely fallback — a random suffix that is still unique-checked.
      for (let i = 0; i < 20; i += 1) {
        const candidate = `EMP-${Math.floor(10000 + Math.random() * 89999)}`;
        const clash = await StaffProfile.findOne({ employeeNumber: candidate }).select({ _id: 1 }).lean();
        if (!clash) return candidate;
      }
      throw staffError('DUPLICATE_STAFF');
    });
  }

  async createStaff(tenantId, input) {
    return withTenant(tenantId, async () => {
      try {
        const doc = await StaffProfile.create(input);
        return toStaff(doc.toObject());
      } catch (err) {
        if (isDuplicateKey(err)) throw staffError('DUPLICATE_STAFF');
        throw err;
      }
    });
  }

  /** Display-name fields for many staff members in ONE query (no email/user lookup). */
  async findStaffNamesByIds(tenantId, staffIds) {
    if (!staffIds?.length) return [];
    return withTenant(tenantId, async () => {
      const docs = await StaffProfile.find({ _id: { $in: staffIds }, deletedAt: null }).select({ firstName: 1, lastName: 1 }).lean();
      return docs.map((d) => ({ id: d._id, firstName: d.firstName ?? null, lastName: d.lastName ?? null }));
    });
  }

  async findStaffById(tenantId, staffId) {
    return withTenant(tenantId, async () => {
      const doc = await StaffProfile.findOne({ _id: staffId, deletedAt: null }).lean();
      if (!doc) return null;
      const emails = await resolveEmails([doc.userId]);
      return { ...toStaff(doc), email: emails.get(doc.userId) ?? null };
    });
  }

  /**
   * Resolve the staff profile for a user (spec Module 7.1). Lets a plan derive
   * its responsible BCBA from the AUTHENTICATED creator instead of asking for it
   * in the form. Tenant-scoped; returns null when the user has no staff profile.
   */
  async findStaffByUserId(tenantId, userId) {
    if (!userId) return null;
    return withTenant(tenantId, async () => {
      const doc = await StaffProfile.findOne({ userId, deletedAt: null }).lean();
      return doc ? toStaff(doc) : null;
    });
  }

  async listStaff(tenantId, query) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null };
      // Blueprint 4.5: an RBT's staff visibility is own-scope. They may resolve
      // themselves and their supervisor relationship, not browse the roster.
      if (query.dataScope) scopeToStaff(filter, query.dataScope, '_id');
      if (query.status) filter.status = query.status;
      if (query.search) {
        const rx = new RegExp(escapeRegExp(query.search), 'i');
        filter.$or = [{ firstName: rx }, { lastName: rx }, { employeeNumber: rx }];
      }
      if (query.cursor) filter._id = { $lt: query.cursor };
      const limit = query.limit ?? 25;
      const rows = await StaffProfile.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const roles = await resolveRoleKeys(page);
      const emails = await resolveEmails(page.map((d) => d.userId));
      return {
        items: page.map((doc) => ({ ...toStaff(doc), roleKeys: roles.get(doc.userId) ?? [], email: emails.get(doc.userId) ?? null })),
        nextCursor: hasMore ? page[page.length - 1]._id : null,
      };
    });
  }


  async updateStaff(tenantId, staffId, patch, expectedVersion) {
    return withTenant(tenantId, async () => {
      const updated = await StaffProfile.findOneAndUpdate(
        { _id: staffId, deletedAt: null, version: expectedVersion },
        { $set: patch, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (updated) return toStaff(updated);
      const exists = await StaffProfile.exists({ _id: staffId, deletedAt: null });
      throw staffError(exists ? 'VERSION_CONFLICT' : 'STAFF_NOT_FOUND');
    });
  }

  /**
   * The staff member's ACTIVE care-team assignments with the client's display
   * name, newest first. Archived clients and ended/deleted assignments are
   * excluded. One query per collection.
   */
  async listActiveAssignmentsForStaff(tenantId, staffId) {
    return withTenant(tenantId, async () => {
      const rows = await ClientAssignment.find({ staffProfileId: staffId, status: 'ACTIVE', deletedAt: null })
        .select({ _id: 1, clientId: 1, role: 1, isPrimary: 1, weeklyAssignedHours: 1, effectiveStartDate: 1 })
        .sort({ effectiveStartDate: -1, _id: -1 })
        .lean();
      if (!rows.length) return [];
      const clients = await Client.find({ _id: { $in: [...new Set(rows.map((r) => r.clientId))] }, deletedAt: null })
        .select({ _id: 1, firstName: 1, lastName: 1, preferredName: 1, status: 1 })
        .lean();
      const byId = new Map(clients.map((c) => [c._id, c]));
      return rows.filter((r) => byId.has(r.clientId)).map((r) => {
        const c = byId.get(r.clientId);
        const preferred = c.preferredName && String(c.preferredName).trim();
        return {
          assignmentId: r._id,
          clientId: r.clientId,
          clientName: preferred || [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || null,
          clientStatus: c.status,
          role: r.role,
          isPrimary: Boolean(r.isPrimary),
          weeklyAssignedHours: r.weeklyAssignedHours ?? null,
          effectiveStartDate: toDateOnly(r.effectiveStartDate),
        };
      });
    });
  }

  async deactivateStaff(tenantId, staffId, actorUserId) {
    return withTenant(tenantId, async () => {
      const now = new Date();
      let result;
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        const res = await StaffProfile.updateOne(
          { _id: staffId, deletedAt: null },
          { $set: { status: 'INACTIVE', deletedAt: now, deletedBy: actorUserId, updatedBy: actorUserId } },
          opt,
        );
        if (!res.matchedCount) throw staffError('STAFF_NOT_FOUND');
        // End the staff member's active supervision relationships (either side).
        await SupervisionLink.updateMany(
          { $or: [{ supervisorStaffId: staffId }, { superviseeStaffId: staffId }], active: true, deletedAt: null },
          { $set: { active: false, endDate: now } },
          opt,
        );
        result = { staffId, status: 'INACTIVE' };
      });
      return result;
    });
  }

  // --- credentials ---------------------------------------------------------

  async listCredentials(tenantId, staffProfileId) {
    return withTenant(tenantId, async () => {
      const rows = await Credential.find({ staffProfileId, deletedAt: null }).sort({ expiresDate: 1 }).lean();
      return rows.map(toCredential);
    });
  }

  async addCredential(tenantId, staffProfileId, input) {
    return withTenant(tenantId, async () => {
      const doc = await Credential.create({ ...input, staffProfileId });
      return toCredential(doc.toObject());
    });
  }

  async updateCredential(tenantId, staffProfileId, credentialId, patch) {
    return withTenant(tenantId, async () => {
      const updated = await Credential.findOneAndUpdate(
        { _id: credentialId, staffProfileId, deletedAt: null },
        { $set: patch },
        { new: true },
      ).lean();
      if (!updated) throw staffError('CREDENTIAL_NOT_FOUND');
      return toCredential(updated);
    });
  }

  async removeCredential(tenantId, staffProfileId, credentialId, actorUserId) {
    return withTenant(tenantId, async () => {
      const res = await Credential.updateOne(
        { _id: credentialId, staffProfileId, deletedAt: null },
        { $set: { deletedAt: new Date(), deletedBy: actorUserId } },
      );
      if (!res.matchedCount) throw staffError('CREDENTIAL_NOT_FOUND');
    });
  }

  /** Active credentials expiring on or before `before` — feeds the expiry scan. */
  async listExpiringCredentials(tenantId, before) {
    return withTenant(tenantId, async () => {
      const rows = await Credential.find({
        deletedAt: null,
        status: 'ACTIVE',
        expiresDate: { $ne: null, $lte: before },
      }).lean();
      return rows.map(toCredential);
    });
  }

  // --- supervision ---------------------------------------------------------

  async listSupervisees(tenantId, supervisorStaffId) {
    return withTenant(tenantId, async () => {
      const rows = await SupervisionLink.find({ supervisorStaffId, active: true, deletedAt: null }).lean();
      return rows.map(toSupervision);
    });
  }

  async listSupervisors(tenantId, superviseeStaffId) {
    return withTenant(tenantId, async () => {
      const rows = await SupervisionLink.find({ superviseeStaffId, active: true, deletedAt: null }).lean();
      return rows.map(toSupervision);
    });
  }

  async assignSupervisee(tenantId, supervisorStaffId, superviseeStaffId, startDate) {
    return withTenant(tenantId, async () => {
      try {
        const doc = await SupervisionLink.create({
          supervisorStaffId,
          superviseeStaffId,
          active: true,
          ...(startDate ? { startDate } : {}),
        });
        return toSupervision(doc.toObject());
      } catch (err) {
        if (isDuplicateKey(err)) throw staffError('DUPLICATE_SUPERVISION');
        throw err;
      }
    });
  }

  async endSupervision(tenantId, supervisorStaffId, superviseeStaffId) {
    return withTenant(tenantId, async () => {
      const res = await SupervisionLink.updateOne(
        { supervisorStaffId, superviseeStaffId, active: true, deletedAt: null },
        { $set: { active: false, endDate: new Date() } },
      );
      if (!res.matchedCount) throw staffError('SUPERVISION_NOT_FOUND');
    });
  }

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

// --- helpers ---------------------------------------------------------------

function isDuplicateKey(err) {
  return err && (err.code === 11000 || err.code === 11001);
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toStaff(doc) {
  return {
    id: doc._id,
    userId: doc.userId,
    firstName: doc.firstName,
    middleName: doc.middleName ?? null,
    lastName: doc.lastName,
    title: doc.title ?? null,
    discipline: doc.discipline ?? null,
    employeeNumber: doc.employeeNumber ?? null,
    status: doc.status,
    startDate: toDateOnly(doc.startDate),
    notes: doc.notes ?? null,
    createdAt: doc.createdAt,
    version: doc.version,
  };
}

function toCredential(doc) {
  return {
    id: doc._id,
    staffProfileId: doc.staffProfileId,
    credentialType: doc.credentialType,
    number: doc.number ?? null,
    issuingAuthority: doc.issuingAuthority ?? null,
    issuedDate: toDateOnly(doc.issuedDate),
    expiresDate: toDateOnly(doc.expiresDate),
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

function toSupervision(doc) {
  return {
    id: doc._id,
    supervisorStaffId: doc.supervisorStaffId,
    superviseeStaffId: doc.superviseeStaffId,
    startDate: toDateOnly(doc.startDate),
    endDate: toDateOnly(doc.endDate),
    active: !!doc.active,
  };
}

export const staffRepository = new StaffRepository();


/**
 * Each staff member's RBAC role keys, resolved through their membership.
 *
 * A StaffProfile records who someone is CLINICALLY (name, discipline,
 * credentials); their PERMISSIONS live on MembershipRole. Nothing joined the
 * two, so the care-team assignment screen could not tell a BCBA from a
 * technician: it offered the whole roster for every role and the user
 * discovered the mismatch as a rejection after choosing.
 *
 * Returned as an array because one person can legitimately hold several roles
 * — blueprint 4.12 treats multi-role users as the normal case, not an edge.
 *
 * Runs inside the caller's tenant context, so a membership in another
 * organization is invisible here exactly as it is everywhere else.
 */
async function resolveEmails(userIds) {
  const byUser = new Map();
  const ids = [...new Set((userIds ?? []).filter(Boolean))];
  if (ids.length === 0) return byUser;
  // Email is canonical on the global User row (platform-scoped), never on
  // StaffProfile. Batched — one query for the whole page.
  const users = await withPlatform(() => User.find({ _id: { $in: ids } }).select({ _id: 1, email: 1 }).lean());
  for (const u of users) byUser.set(u._id, u.email ?? null);
  return byUser;
}

export async function resolveRoleKeys(staffDocs) {
  const byUser = new Map();
  const userIds = staffDocs.map((d) => d.userId).filter(Boolean);
  if (userIds.length === 0) return byUser;

  const memberships = await Membership.find({ userId: { $in: userIds } })
    .select({ _id: 1, userId: 1 }).lean();
  if (memberships.length === 0) return byUser;

  const membershipRoles = await MembershipRole.find({
    membershipId: { $in: memberships.map((m) => m._id) },
  }).select({ membershipId: 1, roleId: 1 }).lean();
  if (membershipRoles.length === 0) return byUser;

  const roles = await Role.find({ _id: { $in: membershipRoles.map((r) => r.roleId) } })
    .select({ _id: 1, key: 1 }).lean();
  const keyById = new Map(roles.map((r) => [r._id, r.key]));
  const rolesByMembership = new Map();
  for (const mr of membershipRoles) {
    const key = keyById.get(mr.roleId);
    if (!key) continue;
    if (!rolesByMembership.has(mr.membershipId)) rolesByMembership.set(mr.membershipId, []);
    rolesByMembership.get(mr.membershipId).push(key);
  }
  for (const m of memberships) {
    byUser.set(m.userId, rolesByMembership.get(m._id) ?? []);
  }
  return byUser;
}
