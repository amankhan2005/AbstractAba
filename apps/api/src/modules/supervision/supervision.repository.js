import { SupervisionObservation, SupervisionHourLog, SupervisionLink, StaffProfile } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';

/**
 * Persistence for the supervision workflow. Every operation runs under
 * withTenant(): the tenant plugin stamps tenantId on writes and scopes every
 * read, failing closed without a context. IDOR is prevented structurally — a
 * lookup by id is always additionally constrained to the active tenant, so a
 * guessed id from another tenant simply returns null.
 */
export class SupervisionRepository {
  // --- observations --------------------------------------------------------
  async createObservation(tenantId, doc) {
    return withTenant(tenantId, async () => {
      const created = await SupervisionObservation.create(doc);
      return toObservation(created.toObject());
    });
  }

  async findObservationById(tenantId, id) {
    return withTenant(tenantId, async () => {
      const row = await SupervisionObservation.findOne({ _id: id, deletedAt: null }).lean();
      return row ? toObservation(row) : null;
    });
  }

  async listObservations(tenantId, { supervisorStaffId, superviseeStaffId, status, limit = 50 } = {}) {
    return withTenant(tenantId, async () => {
      const q = { deletedAt: null };
      if (supervisorStaffId) q.supervisorStaffId = supervisorStaffId;
      if (superviseeStaffId) q.superviseeStaffId = superviseeStaffId;
      if (status) q.status = status;
      const rows = await SupervisionObservation.find(q).sort({ observedAt: -1 }).limit(Math.min(limit, 200)).lean();
      return rows.map(toObservation);
    });
  }

  /** Update a DRAFT observation's editable fields; returns null if not found/not mutable. */
  async updateDraftObservation(tenantId, id, patch) {
    return withTenant(tenantId, async () => {
      const row = await SupervisionObservation.findOneAndUpdate(
        { _id: id, deletedAt: null, status: 'DRAFT' },
        { $set: patch, $inc: { version: 1 } },
        { new: true },
      ).lean();
      return row ? toObservation(row) : null;
    });
  }

  /** Apply a workflow transition (status + server-authoritative stamps). */
  async transitionObservation(tenantId, id, fromStatus, patch) {
    return withTenant(tenantId, async () => {
      const row = await SupervisionObservation.findOneAndUpdate(
        { _id: id, deletedAt: null, status: fromStatus },
        { $set: patch, $inc: { version: 1 } },
        { new: true },
      ).lean();
      return row ? toObservation(row) : null;
    });
  }

  async linkSupersession(tenantId, oldId, newId) {
    return withTenant(tenantId, async () => {
      await SupervisionObservation.updateOne(
        { _id: oldId, deletedAt: null },
        { $set: { status: 'SUPERSEDED', supersededByObservationId: newId }, $inc: { version: 1 } },
      );
    });
  }

  // --- supervision links (existence check for validation) ------------------
  async findActiveLink(tenantId, supervisorStaffId, superviseeStaffId) {
    return withTenant(tenantId, async () => {
      const row = await SupervisionLink.findOne({ supervisorStaffId, superviseeStaffId, active: true, deletedAt: null }).lean();
      return row ? { id: row._id } : null;
    });
  }

  async staffExists(tenantId, staffId) {
    return withTenant(tenantId, async () => {
      const row = await StaffProfile.findOne({ _id: staffId, deletedAt: null }).select({ _id: 1 }).lean();
      return !!row;
    });
  }

  // --- hour logs -----------------------------------------------------------
  async createHourLog(tenantId, doc) {
    return withTenant(tenantId, async () => {
      const created = await SupervisionHourLog.create(doc);
      return toHourLog(created.toObject());
    });
  }

  async listHourLogs(tenantId, { supervisorStaffId, superviseeStaffId, from, to, limit = 200 } = {}) {
    return withTenant(tenantId, async () => {
      const q = { deletedAt: null };
      if (supervisorStaffId) q.supervisorStaffId = supervisorStaffId;
      if (superviseeStaffId) q.superviseeStaffId = superviseeStaffId;
      if (from || to) { q.date = {}; if (from) q.date.$gte = from; if (to) q.date.$lte = to; }
      const rows = await SupervisionHourLog.find(q).sort({ date: -1 }).limit(Math.min(limit, 500)).lean();
      return rows.map(toHourLog);
    });
  }
}

function toObservation(row) {
  const { _id, __v, ...rest } = row;
  return { id: _id, ...rest };
}
function toHourLog(row) {
  const { _id, __v, ...rest } = row;
  return { id: _id, ...rest };
}

export const supervisionRepository = new SupervisionRepository();
