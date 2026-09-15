import { EmailTemplate } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { clientsError } from './clients.errors.js';

/**
 * Tenant-scoped persistence for saved parent-email templates. Every method runs
 * under withTenant, so a template id from another organization is simply not
 * found. Deletes are soft (history kept); a deleted template frees its name.
 */
export const nameKeyOf = (name) => String(name ?? '').trim().toLowerCase();

function toTemplate(doc) {
  return {
    id: doc._id,
    name: doc.name,
    subject: doc.subject,
    body: doc.body,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    version: doc.version,
  };
}

const isDuplicateKey = (err) => err?.code === 11000;

export const emailTemplatesRepository = {
  async list(tenantId) {
    return withTenant(tenantId, async () => {
      const rows = await EmailTemplate.find({ deletedAt: null }).sort({ updatedAt: -1, _id: -1 }).limit(500).lean();
      return rows.map(toTemplate);
    });
  },

  async findById(tenantId, id) {
    return withTenant(tenantId, async () => {
      const doc = await EmailTemplate.findOne({ _id: id, deletedAt: null }).lean();
      return doc ? toTemplate(doc) : null;
    });
  },

  async create(tenantId, { name, subject, body, actorUserId }) {
    return withTenant(tenantId, async () => {
      try {
        const doc = await EmailTemplate.create({ name, nameKey: nameKeyOf(name), subject, body, createdBy: actorUserId, updatedBy: actorUserId });
        return toTemplate(doc.toObject());
      } catch (err) {
        if (isDuplicateKey(err)) throw clientsError('EMAIL_TEMPLATE_NAME_EXISTS');
        throw err;
      }
    });
  },

  async update(tenantId, id, patch, expectedVersion, actorUserId) {
    return withTenant(tenantId, async () => {
      const set = { ...patch, updatedBy: actorUserId };
      if (patch.name !== undefined) set.nameKey = nameKeyOf(patch.name);
      try {
        const doc = await EmailTemplate.findOneAndUpdate(
          { _id: id, deletedAt: null, version: expectedVersion },
          { $set: set, $inc: { version: 1 } },
          { new: true },
        ).lean();
        if (doc) return toTemplate(doc);
      } catch (err) {
        if (isDuplicateKey(err)) throw clientsError('EMAIL_TEMPLATE_NAME_EXISTS');
        throw err;
      }
      const exists = await EmailTemplate.exists({ _id: id, deletedAt: null });
      throw clientsError(exists ? 'VERSION_CONFLICT' : 'EMAIL_TEMPLATE_NOT_FOUND');
    });
  },

  async softDelete(tenantId, id, actorUserId) {
    return withTenant(tenantId, async () => {
      const res = await EmailTemplate.updateOne(
        { _id: id, deletedAt: null },
        { $set: { deletedAt: new Date(), deletedBy: actorUserId, updatedBy: actorUserId } },
      );
      if (!res.matchedCount) throw clientsError('EMAIL_TEMPLATE_NOT_FOUND');
      return { id, deleted: true };
    });
  },
};
