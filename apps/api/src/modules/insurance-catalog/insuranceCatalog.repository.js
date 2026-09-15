import { InsuranceCatalog } from '../../models/index.js';

/**
 * Data access for the platform-global insurance catalog. NOT tenant-scoped:
 * these are curated by the Super Admin and read (filtered) by every company.
 * Soft-delete only — entries are never hard-removed, since a coverage record
 * may reference one.
 */
function toEntry(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    name: doc.name,
    states: Array.isArray(doc.states) ? doc.states : [],
    logoUrl: doc.logoUrl ?? null,
    active: doc.active !== false,
    notes: doc.notes ?? null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
}

export const insuranceCatalogRepository = {
  async list({ activeOnly = false, state = null } = {}) {
    const q = { deletedAt: null };
    if (activeOnly) q.active = true;
    if (state) q.states = String(state).toUpperCase();
    const docs = await InsuranceCatalog.find(q).sort({ name: 1 }).lean();
    return docs.map(toEntry);
  },
  async findById(id) {
    const doc = await InsuranceCatalog.findOne({ _id: id, deletedAt: null }).lean();
    return toEntry(doc);
  },
  async create(doc) {
    const created = await InsuranceCatalog.create(doc);
    return toEntry(created.toObject());
  },
  async update(id, patch) {
    const doc = await InsuranceCatalog.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: patch },
      { new: true },
    ).lean();
    return toEntry(doc);
  },
  async softDelete(id, actorUserId) {
    await InsuranceCatalog.updateOne(
      { _id: id, deletedAt: null },
      { $set: { deletedAt: new Date(), deletedBy: actorUserId ?? null, active: false } },
    );
    return { id, deleted: true };
  },
};
