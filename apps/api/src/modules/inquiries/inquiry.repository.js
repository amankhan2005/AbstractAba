import { Inquiry } from '../../models/index.js';
import { withPlatform } from '../../tenancy/tenantContext.js';

/**
 * Persistence for public website inquiries. Inquiries are platform-level
 * records (they arrive before any organization exists), so every query runs in
 * the platform scope and no tenant plugin applies.
 */
function toInquiry(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    name: doc.name,
    organization: doc.organization,
    email: doc.email,
    phone: doc.phone ?? null,
    subject: doc.subject,
    message: doc.message,
    status: doc.status,
    contactedAt: doc.contactedAt ?? null,
    closedAt: doc.closedAt ?? null,
    internalNote: doc.internalNote ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class InquiryRepository {
  async create(input) {
    return withPlatform(async () => toInquiry((await Inquiry.create(input)).toObject()));
  }

  async findRecentDuplicate(submissionKey, since) {
    return withPlatform(async () =>
      toInquiry(await Inquiry.findOne({ submissionKey, createdAt: { $gte: since } }).lean()),
    );
  }

  async list({ status } = {}) {
    return withPlatform(async () => {
      const docs = await Inquiry.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(500).lean();
      return docs.map(toInquiry);
    });
  }

  async countByStatus() {
    return withPlatform(async () => {
      const rows = await Inquiry.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
      return Object.fromEntries(rows.map((r) => [r._id, r.n]));
    });
  }

  async findById(id) {
    return withPlatform(async () => toInquiry(await Inquiry.findById(id).lean()));
  }

  async update(id, patch) {
    return withPlatform(async () =>
      toInquiry(await Inquiry.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean()),
    );
  }
}
