import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/**
 * Structured medical data a child accumulates — CONDITIONS (ongoing diagnoses)
 * and HISTORY (dated events/notes). One tenant-owned collection referenced by
 * clientId, following the same pattern as Guardian/Contact rather than a second
 * child/document system. The two logical sections (Medical Conditions, Medical
 * History) are distinguished by `type`; they share the same small field set the
 * blueprint calls for (label, dates, status, provider, notes) so there is no
 * near-duplicate model. Company/Admin owns writes; clinicians read (scoped +
 * field-filtered by clients.visibility).
 */
export const MEDICAL_ENTRY_TYPE = ['CONDITION', 'HISTORY'];
export const MEDICAL_ENTRY_STATUS = ['ACTIVE', 'RESOLVED', 'CHRONIC', 'MONITORING'];

const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientId: { type: String, required: true, index: true },
    type: { type: String, enum: MEDICAL_ENTRY_TYPE, required: true },
    // The condition name (CONDITION) or the event/summary (HISTORY).
    label: { type: String, required: true, trim: true },
    // Onset (CONDITION) or the date the history event occurred (HISTORY).
    onsetDate: { type: Date, default: null },
    status: { type: String, enum: MEDICAL_ENTRY_STATUS, default: 'ACTIVE' },
    provider: { type: String, default: null, trim: true },
    notes: { type: String, default: null },
    // Reuses the existing documents/storage system — these are ClinicalDocument
    // ids (image/PDF), never a second file store. Ownership (same client+tenant)
    // is validated on write.
    attachments: { type: [String], default: [] },
  },
  { timestamps: true, versionKey: false, collection: 'clientMedicalEntry' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, clientId: 1, type: 1 });

export const ClientMedicalEntry = mongoose.model('ClientMedicalEntry', schema);
