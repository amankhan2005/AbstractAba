import { unitsToHours } from '../../domain/units.js';
import { toDateOnly } from '../../utils/format.js';
import mongoose from 'mongoose';
import { currentCareTeamByClient } from './clients.careteam.js';
import crypto from 'node:crypto';
import { Client, Guardian, Contact, IntakeForm, ClientAssignment, StaffProfile, ServiceAuthorization, Goal, ClientMedicalEntry, ClinicalDocument, Membership, MembershipRole, Role } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { supportsTransactions } from '../../config/db.js';
import { clientsError } from './clients.errors.js';
import { VALID_PARENT_GUARDIAN_QUERY, deriveAccountStatus } from './clients.alerts.js';

/**
 * Persistence for the clients module (MongoDB/Mongoose). Every tenant-owned
 * operation runs under withTenant(); the tenant plugin stamps and scopes each
 * one and fails closed without a context. Multi-document writes use a
 * transaction when the deployment is a replica set and a safe sequence
 * otherwise (unique indexes and the version guard remain the integrity
 * anchors) — the same _maybeTx approach the users repository uses.
 *
 * Stored PHI (client.sensitive.ssn, intake.insurance.memberId) is opaque
 * ciphertext to this layer: the service seals before writing and opens after
 * reading. The repository never seals, opens, or logs those values.
 */
export class ClientsRepository {
  // --- clients --------------------------------------------------------------

  async createClient(tenantId, input) {
    return withTenant(tenantId, async () => {
      // Allocate a unique, opaque client number; retry on the unique-index
      // collision that a concurrent create could cause.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const clientNumber = generateClientNumber();
        try {
          const doc = await Client.create({ ...input, clientNumber });
          return toClient(doc);
        } catch (err) {
          if (isDuplicateKey(err)) continue;
          throw err;
        }
      }
      throw clientsError('CLIENT_NUMBER_EXHAUSTED');
    });
  }

  /** Display-name fields for many clients in ONE query (no other client data). */
  async findClientNamesByIds(tenantId, clientIds) {
    if (!clientIds?.length) return [];
    return withTenant(tenantId, async () => {
      const docs = await Client.find({ _id: { $in: clientIds }, deletedAt: null }).select({ firstName: 1, lastName: 1, preferredName: 1 }).lean();
      return docs.map((d) => ({ id: d._id, firstName: d.firstName ?? null, lastName: d.lastName ?? null, preferredName: d.preferredName ?? null }));
    });
  }

  async findClientById(tenantId, clientId) {
    return withTenant(tenantId, async () => {
      const doc = await Client.findOne({ _id: clientId, deletedAt: null }).lean();
      return doc ? toClient(doc) : null;
    });
  }

  async listClients(tenantId, query) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null };
      // Data-scope narrowing (blueprint 4.1). `null` means tenant-wide; an
      // array — including an EMPTY one — means "only these". An empty array
      // must produce zero rows, never an unfiltered query.
      const and = [];
      if (Array.isArray(query.clientIds)) and.push({ _id: { $in: query.clientIds } });
      if (query.status) filter.status = query.status;
      if (query.search) {
        const rx = new RegExp(escapeRegExp(query.search), 'i');
        filter.$or = [{ firstName: rx }, { lastName: rx }, { clientNumber: rx }];
      }
      if (query.cursor) and.push({ _id: { $lt: query.cursor } });
      // ACCOUNT status filter — the same rule as deriveAccountStatus, as a query.
      if (query.accountStatus) {
        if (query.accountStatus === 'DISCHARGED') {
          and.push({ status: 'DISCHARGED' });
        } else {
          const validIds = await this._validParentClientIds(Array.isArray(query.clientIds) ? query.clientIds : null);
          and.push(query.accountStatus === 'ACTIVE'
            ? { status: { $nin: ['DISCHARGED', 'ON_HOLD'] }, _id: { $in: validIds } }
            : { status: { $ne: 'DISCHARGED' }, $or: [{ status: 'ON_HOLD' }, { _id: { $nin: validIds } }] });
        }
      }
      if (and.length) filter.$and = and;
      const limit = query.limit ?? 25;
      const rows = await Client.find(filter)
        // never project the sealed envelope into a list
        .select({ sensitive: 0 })
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      // Attach each child's FBA/ABA authorization status in one grouped lookup
      // (no N+1) so the Active Children queue shows real values, not a guess.
      const ids = page.map((r) => r._id);
      const [auths, validParentIds] = ids.length
        ? await Promise.all([
          // Archived authorizations are not the client's current state.
          ServiceAuthorization.find({ clientId: { $in: ids }, deletedAt: null }).select({ clientId: 1, serviceType: 1, status: 1 }).sort({ createdAt: -1 }).lean(),
          this._validParentClientIds(ids),
        ])
        : [[], []];
      const validParentSet = new Set(validParentIds);
      const byClient = new Map();
      for (const a of auths) {
        const list = byClient.get(a.clientId) ?? [];
        list.push({ serviceType: a.serviceType, status: a.status });
        byClient.set(a.clientId, list);
      }
      const items = page.map((r) => ({
        ...toClientSummary(r),
        accountStatus: deriveAccountStatus({ status: r.status, hasValidParent: validParentSet.has(r._id) }),
        serviceAuthorizations: byClient.get(r._id) ?? [],
      }));
      // Attach each child's CURRENT care team (the one ACTIVE BCBA + one ACTIVE
      // RBT) in one grouped lookup — no N+1, ENDED assignments excluded so they
      // never show as current. Child scope is already applied above (the list is
      // narrowed to the caller's caseload), so this cannot leak an unrelated
      // child's care team. Staff names are resolved in a single batched read.
      if (ids.length) {
        // One grouped lookup (no N+1); the pure resolver applies the ACTIVE + one
        // BCBA / one RBT rules and excludes ENDED. Child scope is already applied
        // above, so this cannot leak an unrelated child's care team.
        const assignments = await ClientAssignment.find({
          clientId: { $in: ids }, deletedAt: null,
        }).select({ clientId: 1, role: 1, staffProfileId: 1, status: 1 }).lean();
        const staffIds = [...new Set(assignments.map((a) => a.staffProfileId))];
        const staff = staffIds.length
          ? await StaffProfile.find({ _id: { $in: staffIds } }).select({ firstName: 1, lastName: 1 }).lean()
          : [];
        const staffById = new Map(staff.map((s) => [s._id, s]));
        const nameOf = (spid) => { const sp = staffById.get(spid); return sp ? `${sp.lastName}, ${sp.firstName}` : null; };
        const teamByClient = currentCareTeamByClient(ids, assignments, nameOf);
        for (const item of items) item.careTeam = teamByClient.get(item.id) ?? { bcba: null, rbt: null };
      } else {
        for (const item of items) item.careTeam = { bcba: null, rbt: null };
      }
      return { items, nextCursor: hasMore ? page[page.length - 1]._id : null };
    });
  }

  /**
   * Ids of clients (optionally within `clientIds`) that have at least one valid
   * parent/guardian. Runs inside the caller's tenant context.
   */
  async _validParentClientIds(clientIds = null) {
    const q = { ...VALID_PARENT_GUARDIAN_QUERY };
    if (Array.isArray(clientIds)) q.clientId = { $in: clientIds };
    return Guardian.distinct('clientId', q);
  }

  /** True when this client has a valid parent/guardian (tenant-scoped). */
  async hasValidParent(tenantId, clientId) {
    return withTenant(tenantId, async () => (await this._validParentClientIds([clientId])).length > 0);
  }

  /**
   * Client roster summary within the caller's scope: total, ACCOUNT status
   * counts (deriveAccountStatus) and referral-stage counts (Client.status).
   * Archived (soft-deleted) clients are excluded, as in the list.
   */
  async summarizeClients(tenantId, { clientIds } = {}) {
    return withTenant(tenantId, async () => {
      const match = { deletedAt: null };
      if (Array.isArray(clientIds)) match._id = { $in: clientIds };
      const [rows, validIds] = await Promise.all([
        Client.aggregate([{ $match: match }, { $group: { _id: { id: '$_id', status: '$status' } } }]),
        this._validParentClientIds(Array.isArray(clientIds) ? clientIds : null),
      ]);
      const valid = new Set(validIds);
      const account = { ACTIVE: 0, HOLD: 0, DISCHARGED: 0 };
      const stage = {};
      for (const r of rows) {
        account[deriveAccountStatus({ status: r._id.status, hasValidParent: valid.has(r._id.id) })] += 1;
        stage[r._id.status] = (stage[r._id.status] ?? 0) + 1;
      }
      return { total: rows.length, account, stage };
    });
  }

  async updateClient(tenantId, clientId, patch, expectedVersion) {
    return withTenant(tenantId, async () => {
      const updated = await Client.findOneAndUpdate(
        { _id: clientId, deletedAt: null, version: expectedVersion },
        { $set: patch, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (updated) return toClient(updated);
      // Distinguish "gone" from "stale version" so the service can map the code.
      const exists = await Client.exists({ _id: clientId, deletedAt: null });
      throw clientsError(exists ? 'VERSION_CONFLICT' : 'CLIENT_NOT_FOUND');
    });
  }

  async setPrimaryGuardianId(tenantId, clientId, guardianId) {
    return withTenant(tenantId, async () => {
      await Client.updateOne({ _id: clientId, deletedAt: null }, { $set: { primaryGuardianId: guardianId } });
    });
  }

  async archiveClient(tenantId, clientId, actorUserId) {
    return withTenant(tenantId, async () => {
      const client = await Client.findOne({ _id: clientId, deletedAt: null }).lean();
      if (!client) throw clientsError('CLIENT_NOT_FOUND');
      const now = new Date();
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        await Client.updateOne(
          { _id: clientId },
          { $set: { status: 'ARCHIVED', deletedAt: now, deletedBy: actorUserId, updatedBy: actorUserId } },
          opt,
        );
        // Cascade a soft archive to dependents; PHI is retained, not destroyed.
        await Guardian.updateMany({ clientId, deletedAt: null }, { $set: { deletedAt: now, deletedBy: actorUserId } }, opt);
        await Contact.updateMany({ clientId, deletedAt: null }, { $set: { deletedAt: now, deletedBy: actorUserId } }, opt);
        await IntakeForm.updateMany({ clientId, deletedAt: null }, { $set: { deletedAt: now, deletedBy: actorUserId } }, opt);
      });
      return { clientId, status: 'ARCHIVED' };
    });
  }

  // --- guardians ------------------------------------------------------------

  async listGuardians(tenantId, clientId) {
    return withTenant(tenantId, async () => {
      const rows = await Guardian.find({ clientId, deletedAt: null }).sort({ isPrimary: -1, lastName: 1 }).lean();
      return rows.map(toGuardian);
    });
  }

  async findGuardian(tenantId, clientId, guardianId) {
    return withTenant(tenantId, async () => {
      const doc = await Guardian.findOne({ _id: guardianId, clientId, deletedAt: null }).lean();
      return doc ? toGuardian(doc) : null;
    });
  }

  async addGuardian(tenantId, clientId, input) {
    return withTenant(tenantId, async () => {
      let created;
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        if (input.isPrimary) {
          await Guardian.updateMany({ clientId, deletedAt: null, isPrimary: true }, { $set: { isPrimary: false } }, opt);
        }
        const [doc] = await Guardian.create([{ ...input, clientId }], opt);
        created = doc;
        if (input.isPrimary) {
          await Client.updateOne({ _id: clientId, deletedAt: null }, { $set: { primaryGuardianId: doc._id } }, opt);
        }
      });
      return toGuardian(created.toObject ? created.toObject() : created);
    });
  }

  async updateGuardian(tenantId, clientId, guardianId, patch) {
    return withTenant(tenantId, async () => {
      const target = await Guardian.findOne({ _id: guardianId, clientId, deletedAt: null }).lean();
      if (!target) throw clientsError('GUARDIAN_NOT_FOUND');
      let updated;
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        if (patch.isPrimary === true) {
          await Guardian.updateMany(
            { clientId, deletedAt: null, isPrimary: true, _id: { $ne: guardianId } },
            { $set: { isPrimary: false } },
            opt,
          );
          await Client.updateOne({ _id: clientId, deletedAt: null }, { $set: { primaryGuardianId: guardianId } }, opt);
        }
        updated = await Guardian.findOneAndUpdate(
          { _id: guardianId, clientId, deletedAt: null },
          { $set: patch },
          { new: true, ...opt },
        ).lean();
      });
      return toGuardian(updated);
    });
  }

  async removeGuardian(tenantId, clientId, guardianId, actorUserId) {
    return withTenant(tenantId, async () => {
      const target = await Guardian.findOne({ _id: guardianId, clientId, deletedAt: null }).lean();
      if (!target) throw clientsError('GUARDIAN_NOT_FOUND');
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        await Guardian.updateOne(
          { _id: guardianId, clientId },
          { $set: { deletedAt: new Date(), deletedBy: actorUserId, isPrimary: false } },
          opt,
        );
        if (target.isPrimary) {
          await Client.updateOne({ _id: clientId, deletedAt: null, primaryGuardianId: guardianId }, { $set: { primaryGuardianId: null } }, opt);
        }
      });
    });
  }

  // --- medical entries (conditions + history) -------------------------------

  /** Returns the subset of documentIds that are NOT valid attachments for this
   *  client+tenant (unknown or belonging to another child). Empty = all valid. */
  async invalidAttachmentIds(tenantId, clientId, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    return withTenant(tenantId, async () => {
      const rows = await ClinicalDocument.find({ _id: { $in: ids }, clientId, deletedAt: null }).select({ _id: 1 }).lean();
      const ok = new Set(rows.map((r) => r._id));
      return ids.filter((id) => !ok.has(id));
    });
  }

  async _resolveAttachments(entries) {
    const ids = [...new Set(entries.flatMap((e) => e.attachments ?? []))];
    if (ids.length === 0) return entries.map((e) => ({ ...e, attachments: [] }));
    const docs = await ClinicalDocument.find({ _id: { $in: ids }, deletedAt: null })
      .select({ _id: 1, title: 1, contentType: 1, sizeBytes: 1 }).lean();
    const byId = new Map(docs.map((d) => [d._id, { id: d._id, title: d.title, contentType: d.contentType ?? null, sizeBytes: d.sizeBytes ?? null }]));
    return entries.map((e) => ({ ...e, attachments: (e.attachments ?? []).map((id) => byId.get(id)).filter(Boolean) }));
  }

  async listMedicalEntries(tenantId, clientId, type) {
    return withTenant(tenantId, async () => {
      const filter = { clientId, deletedAt: null, ...(type ? { type } : {}) };
      const rows = await ClientMedicalEntry.find(filter).sort({ type: 1, onsetDate: -1, createdAt: -1 }).lean();
      return this._resolveAttachments(rows.map(toMedicalEntry));
    });
  }

  async addMedicalEntry(tenantId, clientId, input) {
    return withTenant(tenantId, async () => {
      const [doc] = await ClientMedicalEntry.create([{ ...input, clientId }]);
      const [resolved] = await this._resolveAttachments([toMedicalEntry(doc.toObject ? doc.toObject() : doc)]);
      return resolved;
    });
  }

  async updateMedicalEntry(tenantId, clientId, entryId, patch) {
    return withTenant(tenantId, async () => {
      const updated = await ClientMedicalEntry.findOneAndUpdate(
        { _id: entryId, clientId, deletedAt: null },
        { $set: patch },
        { new: true },
      ).lean();
      if (!updated) throw clientsError('MEDICAL_ENTRY_NOT_FOUND');
      const [resolved] = await this._resolveAttachments([toMedicalEntry(updated)]);
      return resolved;
    });
  }

  async removeMedicalEntry(tenantId, clientId, entryId) {
    return withTenant(tenantId, async () => {
      const res = await ClientMedicalEntry.updateOne(
        { _id: entryId, clientId, deletedAt: null },
        { $set: { deletedAt: new Date() } },
      );
      if (!res.matchedCount) throw clientsError('MEDICAL_ENTRY_NOT_FOUND');
    });
  }

  // --- contacts -------------------------------------------------------------

  async listContacts(tenantId, clientId) {
    return withTenant(tenantId, async () => {
      const rows = await Contact.find({ clientId, deletedAt: null }).sort({ name: 1 }).lean();
      return rows.map(toContact);
    });
  }

  async findContact(tenantId, clientId, contactId) {
    return withTenant(tenantId, async () => {
      const doc = await Contact.findOne({ _id: contactId, clientId, deletedAt: null }).lean();
      return doc ? toContact(doc) : null;
    });
  }

  async addContact(tenantId, clientId, input) {
    return withTenant(tenantId, async () => {
      const doc = await Contact.create({ ...input, clientId });
      return toContact(doc.toObject());
    });
  }

  async updateContact(tenantId, clientId, contactId, patch) {
    return withTenant(tenantId, async () => {
      const updated = await Contact.findOneAndUpdate(
        { _id: contactId, clientId, deletedAt: null },
        { $set: patch },
        { new: true },
      ).lean();
      if (!updated) throw clientsError('CONTACT_NOT_FOUND');
      return toContact(updated);
    });
  }

  async removeContact(tenantId, clientId, contactId, actorUserId) {
    return withTenant(tenantId, async () => {
      const res = await Contact.updateOne(
        { _id: contactId, clientId, deletedAt: null },
        { $set: { deletedAt: new Date(), deletedBy: actorUserId } },
      );
      if (!res.matchedCount) throw clientsError('CONTACT_NOT_FOUND');
    });
  }

  // --- intake ---------------------------------------------------------------

  async findIntake(tenantId, clientId) {
    return withTenant(tenantId, async () => {
      const doc = await IntakeForm.findOne({ clientId, deletedAt: null }).lean();
      return doc ? toIntake(doc) : null;
    });
  }

  // --- FBA/ABA service authorizations (Phase 2) ----------------------------
  /** Active children with the state the alerts engine needs — assembled with
   *  grouped lookups (no N+1): authorizations and active assignments per child. */
  async listActiveClientsWithAlertState(tenantId, { limit = 500 } = {}) {
    return withTenant(tenantId, async () => {
      const clients = await Client.find({ status: 'ACTIVE', deletedAt: null })
        .select({ _id: 1, clientNumber: 1, firstName: 1, lastName: 1, intakeWorkflowStatus: 1, approvedWeeklyHours: 1 })
        .sort({ lastName: 1, firstName: 1 }).limit(limit).lean();
      const ids = clients.map((c) => c._id);
      if (ids.length === 0) return [];
      const [auths, assignments] = await Promise.all([
        ServiceAuthorization.find({ clientId: { $in: ids } }).select({ clientId: 1, serviceType: 1, status: 1, endDate: 1 }).lean(),
        ClientAssignment.find({ clientId: { $in: ids }, status: { $ne: 'ENDED' }, deletedAt: null }).select({ clientId: 1, role: 1, status: 1, weeklyAssignedHours: 1 }).lean(),
      ]);
      const authByClient = new Map();
      for (const a of auths) { const l = authByClient.get(a.clientId) ?? []; l.push({ serviceType: a.serviceType, status: a.status, endDate: a.endDate ?? null }); authByClient.set(a.clientId, l); }
      const teamByClient = new Map();
      const hoursByClient = new Map();
      for (const a of assignments) {
        const l = teamByClient.get(a.clientId) ?? []; l.push({ role: a.role, status: a.status ?? 'ACTIVE' }); teamByClient.set(a.clientId, l);
        hoursByClient.set(a.clientId, (hoursByClient.get(a.clientId) ?? 0) + (a.weeklyAssignedHours || 0));
      }
      return clients.map((c) => ({
        id: c._id,
        clientNumber: c.clientNumber,
        firstName: c.firstName,
        lastName: c.lastName,
        intakeWorkflowStatus: c.intakeWorkflowStatus ?? 'NOT_SENT',
        approvedWeeklyHours: c.approvedWeeklyHours ?? null,
        assignedWeeklyHours: hoursByClient.get(c._id) ?? 0,
        careTeam: teamByClient.get(c._id) ?? [],
        serviceAuthorizations: authByClient.get(c._id) ?? [],
      }));
    });
  }

  async listServiceAuthorizations(tenantId, clientId) {
    return withTenant(tenantId, async () => {
      const docs = await ServiceAuthorization.find({ clientId, deletedAt: null }).sort({ serviceType: 1 }).lean();
      return docs.map(toServiceAuth);
    });
  }

  async findServiceAuthorization(tenantId, clientId, serviceType) {
    return withTenant(tenantId, async () => {
      const doc = await ServiceAuthorization.findOne({ clientId, serviceType }).lean();
      return doc ? toServiceAuth(doc) : null;
    });
  }

  async findServiceAuthorizationByNumber(tenantId, clientId, authorizationNumber) {
    return withTenant(tenantId, async () => {
      const doc = await ServiceAuthorization.findOne({ clientId, authorizationNumber, deletedAt: null }).lean();
      return doc ? toServiceAuth(doc) : null;
    });
  }

  async listGoalsForClient(tenantId, clientId) {
    return withTenant(tenantId, async () => {
      const rows = await Goal.find({ clientId, deletedAt: null }).sort({ priority: 1, _id: 1 }).lean();
      return rows.map((g) => ({
        id: g._id,
        treatmentPlanId: g.treatmentPlanId,
        description: g.description,
        term: g.term ?? null,
        priority: g.priority ?? null,
        status: g.status ?? 'NOT_STARTED',
        progress: typeof g.progress === 'number' ? g.progress : null,
        updatedAt: g.updatedAt ?? null,
      }));
    });
  }

  async findServiceAuthorizationById(tenantId, authorizationId) {
    return withTenant(tenantId, async () => {
      const doc = await ServiceAuthorization.findOne({ _id: authorizationId, deletedAt: null }).lean();
      return doc ? toServiceAuth(doc) : null;
    });
  }

  async softDeleteServiceAuthorization(tenantId, authorizationId, actorUserId) {
    return withTenant(tenantId, async () => {
      await ServiceAuthorization.updateOne(
        { _id: authorizationId, deletedAt: null },
        { $set: { deletedAt: new Date(), deletedBy: actorUserId ?? null } },
      );
      return { id: authorizationId, deleted: true };
    });
  }

  async createServiceAuthorization(tenantId, doc) {
    return withTenant(tenantId, async () => {
      try {
        const created = await ServiceAuthorization.create(doc);
        return toServiceAuth(created.toObject());
      } catch (err) {
        // The service pre-checks for a duplicate authorization number, but two
        // requests racing past that check would both reach the partial-unique
        // index. Translate that duplicate-key into the SAME clean business error
        // the pre-check raises, so a race can never surface a raw E11000 to the
        // caller (spec Fix 1: "Do NOT return a raw E11000 duplicate key error").
        const mapped = authorizationDuplicateError(err, doc.authorizationNumber);
        if (mapped) throw mapped;
        throw err;
      }
    });
  }

  async updateServiceAuthorization(tenantId, authorizationId, patch, historyEntry) {
    return withTenant(tenantId, async () => {
      const update = { $set: patch };
      if (historyEntry) update.$push = { history: historyEntry };
      const doc = await ServiceAuthorization.findOneAndUpdate({ _id: authorizationId }, update, { new: true }).lean();
      return doc ? toServiceAuth(doc) : null;
    });
  }

  async upsertIntake(tenantId, clientId, patch) {
    return withTenant(tenantId, async () => {
      const doc = await IntakeForm.findOneAndUpdate(
        { clientId, deletedAt: null },
        { $set: patch, $setOnInsert: { clientId } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean();
      return toIntake(doc);
    });
  }

  // --- care team (persistent staff assignment) ------------------------------

  async findStaffProfile(tenantId, staffProfileId) {
    return withTenant(tenantId, async () => {
      const doc = await StaffProfile.findOne({ _id: staffProfileId, deletedAt: null }).lean();
      if (!doc) return null;
      // Canonical role truth (spec Module 4 Parts 8/12): resolve the staff
      // member's RBAC role keys through their membership so care-team eligibility
      // uses real roles, not the legacy free-text discipline field. `discipline`
      // is still returned for legacy fallback but is no longer authoritative.
      const roleKeys = await resolveRoleKeysForUser(doc.userId);
      return {
        id: doc._id,
        userId: doc.userId,
        status: doc.status,
        firstName: doc.firstName,
        lastName: doc.lastName,
        title: doc.title ?? null,
        discipline: doc.discipline ?? null,
        roleKeys,
      };
    });
  }

  /** Staff ids holding an ACTIVE RBT care-team assignment on the client (one lean read). */
  async findActiveRbtStaffIds(tenantId, clientId) {
    return withTenant(tenantId, async () => {
      const rows = await ClientAssignment.find({ clientId, role: 'RBT', status: 'ACTIVE', deletedAt: null })
        .sort({ isPrimary: -1, createdAt: 1 }).select({ staffProfileId: 1 }).lean();
      return [...new Set(rows.map((r) => r.staffProfileId))];
    });
  }

  async listAssignments(tenantId, clientId) {
    return withTenant(tenantId, async () => {
      const rows = await ClientAssignment.find({ clientId, deletedAt: null })
        .sort({ role: 1, isPrimary: -1, createdAt: 1 })
        .lean();
      const staffIds = [...new Set(rows.map((r) => r.staffProfileId))];
      const staff = staffIds.length
        ? await StaffProfile.find({ _id: { $in: staffIds }, deletedAt: null }).lean()
        : [];
      const byId = new Map(staff.map((sp) => [sp._id, sp]));
      return rows.map((r) => toAssignment(r, byId.get(r.staffProfileId)));
    });
  }

  async findAssignment(tenantId, clientId, staffProfileId, role) {
    return withTenant(tenantId, async () => {
      const doc = await ClientAssignment.findOne({ clientId, staffProfileId, role, deletedAt: null }).lean();
      return doc ? toAssignment(doc) : null;
    });
  }

  async addAssignment(tenantId, clientId, input) {
    return withTenant(tenantId, async () => {
      try {
        const [doc] = await ClientAssignment.create([{ ...input, clientId }]);
        return toAssignment(doc.toObject ? doc.toObject() : doc);
      } catch (err) {
        if (isDuplicateKey(err)) throw clientsError('ASSIGNMENT_EXISTS');
        throw err;
      }
    });
  }

  async findAssignmentById(tenantId, assignmentId) {
    return withTenant(tenantId, async () => {
      const doc = await ClientAssignment.findOne({ _id: assignmentId, deletedAt: null }).lean();
      return doc ? toAssignment(doc) : null;
    });
  }

  async updateAssignment(tenantId, assignmentId, patch, rateHistoryEntry) {
    return withTenant(tenantId, async () => {
      const update = { $set: patch };
      if (rateHistoryEntry) update.$push = { rateHistory: rateHistoryEntry };
      const doc = await ClientAssignment.findOneAndUpdate({ _id: assignmentId, deletedAt: null }, update, { new: true }).lean();
      return doc ? toAssignment(doc) : null;
    });
  }

  /** Sum of ACTIVE assignments' weeklyAssignedHours for a child (capacity). An
   *  optional excludeId lets an edit ignore the row being changed. */
  /** ACTIVE care-team members with the linked user account id (for notifying).
   *  Server-side truth — recomputed at send time, never trusted from the client. */
  async listCareTeamRecipients(tenantId, clientId) {
    return withTenant(tenantId, async () => {
      const assignments = await ClientAssignment.find({ clientId, status: { $ne: 'ENDED' }, deletedAt: null }).lean();
      const staffIds = [...new Set(assignments.map((a) => a.staffProfileId))];
      const staff = await StaffProfile.find({ _id: { $in: staffIds }, status: 'ACTIVE', deletedAt: null })
        .select({ _id: 1, userId: 1, firstName: 1, lastName: 1 }).lean();
      const byId = new Map(staff.map((s) => [s._id, s]));
      const out = [];
      for (const a of assignments) {
        const s = byId.get(a.staffProfileId);
        if (!s || !s.userId) continue; // only active staff with a user account
        out.push({ assignmentId: a._id, staffProfileId: a.staffProfileId, userId: s.userId, role: a.role, staffName: `${s.lastName}, ${s.firstName}` });
      }
      return out;
    });
  }

  async sumActiveAssignedHours(tenantId, clientId, excludeId = null) {
    return withTenant(tenantId, async () => {
      const filter = { clientId, status: 'ACTIVE', deletedAt: null, weeklyAssignedHours: { $ne: null } };
      if (excludeId) filter._id = { $ne: excludeId };
      const rows = await ClientAssignment.find(filter).select({ weeklyAssignedHours: 1 }).lean();
      return rows.reduce((sum, r) => sum + (r.weeklyAssignedHours || 0), 0);
    });
  }

  async removeAssignment(tenantId, clientId, assignmentId, actorUserId) {
    return withTenant(tenantId, async () => {
      const target = await ClientAssignment.findOne({ _id: assignmentId, clientId, deletedAt: null }).lean();
      if (!target) throw clientsError('ASSIGNMENT_NOT_FOUND');
      await ClientAssignment.updateOne(
        { _id: assignmentId, clientId },
        { $set: { deletedAt: new Date(), deletedBy: actorUserId } },
      );
    });
  }

  /**
   * Downstream helper for billing/payroll: the care-team role(s) a staff member
   * holds for a client. Returns [] when the staff has no standing assignment on
   * that client (the per-appointment assignment still governs the actual work).
   */
  async rolesForStaffOnClient(tenantId, clientId, staffProfileId) {
    return withTenant(tenantId, async () => {
      const rows = await ClientAssignment.find({ clientId, staffProfileId, deletedAt: null }).lean();
      return rows.map((r) => r.role);
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

/** An opaque, non-sequential client number: CL- + 8 base32 chars. */
function generateClientNumber() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `CL-${out}`;
}

function isDuplicateKey(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

/**
 * Map a Mongo duplicate-key error from a ServiceAuthorization write onto the
 * clean business error the service already uses. Only the authorizationNumber
 * index is unique, so any duplicate key here IS a repeated authorization number.
 * Returns null for non-duplicate errors so the caller rethrows them unchanged.
 * Exported so the translation is unit-testable without a live index.
 */
export function authorizationDuplicateError(err, authorizationNumber = undefined) {
  if (!isDuplicateKey(err)) return null;
  return clientsError('AUTHORIZATION_EXISTS', {
    ...(authorizationNumber ? { context: { authorizationNumber } } : {}),
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toAssignment(doc, staff) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    staffProfileId: doc.staffProfileId,
    role: doc.role,
    isPrimary: doc.isPrimary ?? false,
    weeklyAssignedHours: doc.weeklyAssignedHours ?? null,
    hourlyPayRate: doc.hourlyPayRate ?? null,
    effectiveStartDate: toDateOnly(doc.effectiveStartDate),
    effectiveEndDate: toDateOnly(doc.effectiveEndDate),
    status: doc.status ?? 'ACTIVE',
    rateHistory: Array.isArray(doc.rateHistory)
      ? doc.rateHistory.map((r) => ({ rate: r.rate, effectiveDate: toDateOnly(r.effectiveDate), actorUserId: r.actorUserId ?? null, at: r.at }))
      : [],
    notes: doc.notes ?? null,
    staffName: staff ? `${staff.lastName}, ${staff.firstName}` : null,
    staffTitle: staff ? staff.title ?? null : null,
    createdAt: doc.createdAt,
  };
}

function toClientSummary(doc) {
  return {
    id: doc._id,
    clientNumber: doc.clientNumber,
    firstName: doc.firstName,
    lastName: doc.lastName,
    preferredName: doc.preferredName ?? null,
    status: doc.status,
    intakeWorkflowStatus: doc.intakeWorkflowStatus ?? 'NOT_SENT',
    approvedWeeklyHours: doc.approvedWeeklyHours ?? null,
    dateOfBirth: toDateOnly(doc.dateOfBirth),
    primaryGuardianId: doc.primaryGuardianId ?? null,
    createdAt: doc.createdAt,
    version: doc.version,
  };
}

function toClient(doc) {
  return {
    ...toClientSummary(doc),
    middleName: doc.middleName ?? null,
    sexAtBirth: doc.sexAtBirth ?? null,
    pronouns: doc.pronouns ?? null,
    primaryLanguage: doc.primaryLanguage ?? null,
    email: doc.email ?? null,
    phone: doc.phone ?? null,
    address: doc.address ?? null,
    // sealed ciphertext, opened by the service before it leaves the API
    sensitive: doc.sensitive ?? { ssn: null },
    updatedAt: doc.updatedAt,
  };
}

function toGuardian(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    firstName: doc.firstName,
    lastName: doc.lastName,
    relationship: doc.relationship,
    isPrimary: !!doc.isPrimary,
    phone: doc.phone ?? null,
    email: doc.email ?? null,
    address: doc.address ?? null,
    notes: doc.notes ?? null,
    createdAt: doc.createdAt,
  };
}

function toMedicalEntry(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    type: doc.type,
    label: doc.label,
    onsetDate: toDateOnly(doc.onsetDate),
    status: doc.status ?? 'ACTIVE',
    provider: doc.provider ?? null,
    notes: doc.notes ?? null,
    attachments: Array.isArray(doc.attachments) ? doc.attachments : [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toContact(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    name: doc.name,
    contactType: doc.contactType,
    phone: doc.phone ?? null,
    email: doc.email ?? null,
    organizationName: doc.organizationName ?? null,
    notes: doc.notes ?? null,
    createdAt: doc.createdAt,
  };
}

function toIntake(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    referralSource: doc.referralSource ?? null,
    referralDate: doc.referralDate ?? null,
    presentingConcerns: doc.presentingConcerns ?? null,
    // insurance.memberId is sealed ciphertext, opened by the service
    insurance: doc.insurance ?? { payerName: null, planName: null, memberId: null },
    consents: doc.consents ?? { hipaaAcknowledged: false, treatmentConsent: false, consentedAt: null },
    status: doc.status,
    updatedAt: doc.updatedAt,
  };
}

export const clientsRepository = new ClientsRepository();

export function toServiceAuth(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    clientId: doc.clientId,
    serviceType: doc.serviceType,
    status: doc.status,
    authorizationNumber: doc.authorizationNumber ?? null,
    billingCode: doc.billingCode ?? null,
    // Calendar dates emitted date-only (YYYY-MM-DD) via the canonical serializer
    // so the client renders them timezone-safe as MM/DD/YYYY — never shifted a
    // day west of UTC the way a full ISO datetime would be (spec Parts 18/21).
    startDate: toDateOnly(doc.startDate),
    endDate: toDateOnly(doc.endDate),
    units: doc.units ?? null,
    usedUnits: doc.usedUnits ?? 0,
    // Remaining is derived, never stored — it cannot drift from units - used.
    remainingUnits: doc.units != null ? Math.max(0, doc.units - (doc.usedUnits ?? 0)) : null,
    // Hours are DERIVED from units (1 unit = 15 min), so units and hours can
    // never present conflicting values (spec Module 6 Part 9). Falls back to any
    // stored hours only when units are absent (legacy hours-only rows).
    hours: doc.units != null ? unitsToHours(doc.units) : (doc.hours ?? null),
    unitPrice: doc.unitPrice ?? null,
    comments: doc.comments ?? null,
    history: Array.isArray(doc.history) ? doc.history.map((h) => ({ from: h.from, to: h.to, actorUserId: h.actorUserId ?? null, reason: h.reason ?? null, at: h.at })) : [],
    version: doc.version,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
}

/**
 * Resolve the canonical RBAC role keys for a user (spec Module 4 Parts 8/12).
 * Walks user -> membership(s) -> membership_role -> role.key, within the current
 * tenant context. Returns lowercase keys (e.g. ['bcba'], ['rbt'], ['owner']).
 * Multi-role is normal: a user may hold several keys, and all are returned so the
 * care-team eligibility guard and the frontend filter agree on one source of role
 * truth. Never throws — an unresolvable user simply yields [].
 */
async function resolveRoleKeysForUser(userId) {
  if (!userId) return [];
  const memberships = await Membership.find({ userId }).select({ _id: 1 }).lean();
  if (memberships.length === 0) return [];
  const membershipIds = memberships.map((m) => m._id);
  const membershipRoles = await MembershipRole.find({ membershipId: { $in: membershipIds } })
    .select({ roleId: 1 }).lean();
  if (membershipRoles.length === 0) return [];
  const roles = await Role.find({ _id: { $in: membershipRoles.map((r) => r.roleId) } })
    .select({ key: 1 }).lean();
  return [...new Set(roles.map((r) => r.key).filter(Boolean))];
}

// Calendar-date serialization (DOB, authorization dates) uses the SINGLE
// canonical, timezone-safe toDateOnly from utils/format.js. Re-exported here so
// existing importers of this module keep resolving it from one implementation —
// no duplicate date utility (spec Part 21).
export { toDateOnly } from '../../utils/format.js';
