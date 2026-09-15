import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { SUPERVISION_OBSERVATION_STATUS, SUPERVISION_METHOD } from './enums.js';

/**
 * A supervision observation: a supervisor observes a supervisee (optionally tied
 * to a specific client/session), records findings, and signs it off. Tenant-owned.
 *
 * Lifecycle (see supervision.state.js): DRAFT → SUBMITTED → SIGNED, with
 * SUPERSEDED as the terminal correction state. A SIGNED observation is immutable;
 * corrections are made by superseding it with a new DRAFT (the documents pattern).
 *
 * Sign-off fields (signedBy/signedAt) are server-authoritative — set only by the
 * service from the authenticated principal, never from client input. The observed
 * duration (durationMinutes) feeds supervision-hour tracking.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    supervisorStaffId: { type: String, required: true, index: true },
    superviseeStaffId: { type: String, required: true, index: true },
    supervisionLinkId: { type: String, default: null },
    clientId: { type: String, default: null },
    sessionId: { type: String, default: null },
    observedAt: { type: Date, required: true },
    durationMinutes: { type: Number, required: true, min: 1 },
    method: { type: String, enum: SUPERVISION_METHOD, default: 'IN_PERSON' },
    summary: { type: String, default: '' },
    findings: { type: String, default: '' },
    status: { type: String, enum: SUPERVISION_OBSERVATION_STATUS, default: 'DRAFT', index: true },
    submittedAt: { type: Date, default: null },
    signedAt: { type: Date, default: null },
    signedBy: { type: String, default: null },
    supersedesObservationId: { type: String, default: null },
    supersededByObservationId: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'supervisionObservation' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, supervisorStaffId: 1, observedAt: -1 });
schema.index({ tenantId: 1, superviseeStaffId: 1, observedAt: -1 });
schema.index({ tenantId: 1, status: 1 });

export const SupervisionObservation = mongoose.model('SupervisionObservation', schema);
