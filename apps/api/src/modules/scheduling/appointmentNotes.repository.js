import { AppointmentNote } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';

/**
 * Persistence for appointment notes. Every read and write runs inside
 * `withTenant`, so the tenant filter is applied by the same mechanism the rest
 * of the platform uses rather than being re-implemented here.
 *
 * Identity is the collection's unique key (tenant, appointment, serviceDate).
 * The service only ever passes the CURRENT business date as `serviceDate`.
 */
function toNote(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    appointmentId: doc.appointmentId,
    serviceDate: doc.serviceDate,
    authorStaffProfileId: doc.authorStaffProfileId,
    clientId: doc.clientId ?? null,
    body: doc.body ?? null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    deletedAt: doc.deletedAt ?? null,
  };
}

export const appointmentNotesRepository = {
  async listByAppointment(tenantId, appointmentId) {
    return withTenant(tenantId, async () => {
      const docs = await AppointmentNote.find({ appointmentId, deletedAt: null })
        .sort({ serviceDate: 1 })
        .lean();
      return docs.map(toNote);
    });
  },

  /** The live (not deleted) note for one appointment + business date. */
  async findByAppointmentAndDate(tenantId, appointmentId, serviceDate) {
    return withTenant(tenantId, async () => {
      const doc = await AppointmentNote.findOne({ appointmentId, serviceDate, deletedAt: null }).lean();
      return toNote(doc);
    });
  },

  /** Live notes filed for one business date across the tenant (admin overview). */
  async listForBusinessDate(tenantId, serviceDate, { limit = 500 } = {}) {
    return withTenant(tenantId, async () => {
      const docs = await AppointmentNote.find({ serviceDate, body: { $ne: null }, deletedAt: null })
        .sort({ appointmentId: 1 })
        .limit(limit)
        .lean();
      return docs.map(toNote);
    });
  },

  /**
   * CREATE the note for (appointment, serviceDate). Keyed on the unique index
   * WITHOUT a deletedAt filter, so a row the BCBA deleted earlier the same day
   * — or a non-current row from the retired per-date picker — is taken over
   * instead of colliding with the unique key. Every field is written
   * explicitly: author, client (null unless the BCBA selected one), body. When
   * a live non-current row is taken over, its content is pushed to
   * `supersededVersions` first (`supersede`), never discarded.
   */
  async create(tenantId, { appointmentId, serviceDate, authorStaffProfileId, clientId = null, body, updatedBy, supersede = null }) {
    return withTenant(tenantId, async () => {
      const doc = await AppointmentNote.findOneAndUpdate(
        { appointmentId, serviceDate },
        {
          $set: { authorStaffProfileId, clientId, body, updatedBy, deletedAt: null, deletedBy: null },
          $setOnInsert: { appointmentId, serviceDate, createdBy: updatedBy },
          ...(supersede ? { $push: { supersededVersions: { ...supersede, supersededAt: new Date() } } } : {}),
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean();
      return toNote(doc);
    });
  },

  /**
   * UPDATE the live note. `clientId` is written only when provided (null
   * clears it); the author is never rewritten by an edit.
   */
  async update(tenantId, { appointmentId, serviceDate, body, updatedBy, clientId }) {
    return withTenant(tenantId, async () => {
      const doc = await AppointmentNote.findOneAndUpdate(
        { appointmentId, serviceDate, deletedAt: null },
        { $set: { body, updatedBy, ...(clientId !== undefined ? { clientId } : {}) } },
        { new: true },
      ).lean();
      return toNote(doc);
    });
  },

  /** Soft-delete the live note for (appointment, serviceDate). Nothing else is touched. */
  async softDelete(tenantId, { appointmentId, serviceDate, deletedBy }) {
    return withTenant(tenantId, async () => {
      const doc = await AppointmentNote.findOneAndUpdate(
        { appointmentId, serviceDate, deletedAt: null },
        { $set: { deletedAt: new Date(), deletedBy, updatedBy: deletedBy } },
        { new: true },
      ).lean();
      return toNote(doc);
    });
  },
};
