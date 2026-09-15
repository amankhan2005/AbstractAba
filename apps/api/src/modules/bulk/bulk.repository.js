import { Client, StaffProfile, Authorization, OrganizationExport } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';

/**
 * Data access for bulk import/export. Every query runs inside withTenant so the
 * tenant plugin scopes and fails closed. The tenant is always the caller's
 * active tenant — never from the CSV or the client.
 */
export class BulkRepository {
  /** Return the set of dedupe keys (from the candidate rows) that already exist. */
  async existingKeys(tenantId, entity, candidateRows) {
    if (!candidateRows.length) return new Set();
    return withTenant(tenantId, async () => {
      if (entity === 'clients') {
        const numbers = candidateRows.map((r) => r.clientNumber);
        const rows = await Client.find({ clientNumber: { $in: numbers }, deletedAt: null }).select({ clientNumber: 1 }).lean();
        return new Set(rows.map((r) => String(r.clientNumber).toLowerCase()));
      }
      if (entity === 'staff') {
        const userIds = candidateRows.map((r) => r.userId);
        const rows = await StaffProfile.find({ userId: { $in: userIds }, deletedAt: null }).select({ userId: 1 }).lean();
        return new Set(rows.map((r) => String(r.userId).toLowerCase()));
      }
      return new Set();
    });
  }

  /** Fetch all rows of an entity for export (tenant-scoped, capped). */
  async exportRows(tenantId, entity) {
    return withTenant(tenantId, async () => {
      if (entity === 'clients') return Client.find({ deletedAt: null }).select({ sensitive: 0 }).limit(50000).lean();
      if (entity === 'staff') return StaffProfile.find({ deletedAt: null }).limit(50000).lean();
      if (entity === 'authorizations') return Authorization.find({ deletedAt: null }).limit(50000).lean();
      return [];
    });
  }

  // --- organization export records -----------------------------------------

  async createExport(tenantId, doc) {
    return withTenant(tenantId, async () => {
      const created = await OrganizationExport.create(doc);
      return toExport(created.toObject ? created.toObject() : created);
    });
  }

  async completeExport(tenantId, exportId, patch) {
    return withTenant(tenantId, async () => {
      const updated = await OrganizationExport.findOneAndUpdate({ _id: exportId }, { $set: patch }, { new: true }).lean();
      return updated ? toExport(updated) : null;
    });
  }

  async failExport(tenantId, exportId, failure) {
    return withTenant(tenantId, async () => {
      await OrganizationExport.updateOne({ _id: exportId }, { $set: { state: 'FAILED', failure } });
    });
  }

  async findExportById(tenantId, exportId) {
    return withTenant(tenantId, async () => {
      const row = await OrganizationExport.findOne({ _id: exportId }).lean();
      return row ? toExport(row) : null;
    });
  }

  async listExports(tenantId) {
    return withTenant(tenantId, async () => {
      const rows = await OrganizationExport.find({}).sort({ requestedAt: -1 }).limit(50).lean();
      return rows.map(toExport);
    });
  }

  async markDownloaded(tenantId, exportId) {
    return withTenant(tenantId, async () => {
      await OrganizationExport.updateOne({ _id: exportId }, { $set: { downloadedAt: new Date() } });
    });
  }
}

function toExport(d) {
  return {
    id: d._id,
    state: d.state,
    requestedByUserId: d.requestedByUserId,
    requestedAt: d.requestedAt,
    artifactRef: d.artifactRef ?? null,
    sizeBytes: d.sizeBytes ?? null,
    availableAt: d.availableAt ?? null,
    downloadedAt: d.downloadedAt ?? null,
    expiresAt: d.expiresAt ?? null,
    failure: d.failure ?? null,
  };
}

export const bulkRepository = new BulkRepository();
