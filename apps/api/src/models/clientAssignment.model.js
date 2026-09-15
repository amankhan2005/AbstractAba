import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { CARE_TEAM_ROLE, ASSIGNMENT_STATUS } from './enums.js';

/**
 * A persistent care-team assignment: a staff member holds a named care-team role
 * (Manager, BCBA, RBT, Therapist) for a client/child, company-scoped. A separate
 * tenant-owned collection referenced by clientId — kept independent of the client
 * document (exactly like guardians/contacts) so scheduling, billing and payroll
 * can reference the standing team directly without loading the client.
 *
 * This is the DURABLE team, distinct from and additive to the per-appointment
 * staff assignment (appointment.staffProfileId), which is untouched. A client may
 * have several staff in a role (two RBTs) and a staff may hold several roles; the
 * pair (client, staff, role) is unique among ACTIVE rows. Deactivation is a soft
 * delete so history is retained and the unique constraint frees the slot.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientId: { type: String, required: true, index: true },
    staffProfileId: { type: String, required: true },
    role: { type: String, enum: CARE_TEAM_ROLE, required: true },
    isPrimary: { type: Boolean, default: false },
    // Phase 3: therapist capacity + compensation for this child.
    weeklyAssignedHours: { type: Number, default: null, min: 0 },
    hourlyPayRate: { type: Number, default: null, min: 0 },
    effectiveStartDate: { type: Date, default: null },
    effectiveEndDate: { type: Date, default: null },
    status: { type: String, enum: ASSIGNMENT_STATUS, default: 'ACTIVE', index: true },
    // Append-only rate history: past payroll must resolve by service date, so a
    // rate change never rewrites earlier entries — it appends a new one.
    rateHistory: {
      type: [new mongoose.Schema({
        rate: { type: Number, required: true, min: 0 },
        effectiveDate: { type: Date, required: true },
        actorUserId: { type: String, default: null },
        at: { type: Date, default: () => new Date() },
      }, { _id: false })],
      default: [],
    },
    notes: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'clientAssignment' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
// one live assignment per (client, staff, role); soft-deleted rows are excluded
schema.index(
  { tenantId: 1, clientId: 1, staffProfileId: 1, role: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
schema.index({ tenantId: 1, clientId: 1 });
// downstream billing/payroll: resolve a staff member's assigned clients/roles
schema.index({ tenantId: 1, staffProfileId: 1 });

export const ClientAssignment = mongoose.model('ClientAssignment', schema);
