import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { US_STATE_CODES } from './enums.js';

/**
 * INSURANCE MASTER CATALOG — spec Module 5.1-5.5.
 *
 * Platform-owned reference data curated by the Super Admin (platform operator):
 * the list of insurers a company may pick from when recording client coverage.
 * Each entry is state-specific — an insurer is available in one or more US
 * states (e.g. "California -> Insurance A") — and carries a logo for display.
 *
 * SCOPE. This is GLOBAL platform data, deliberately NOT tenant-scoped (no
 * tenantPlugin): every company reads the same catalog, filtered to its own
 * service states. Writes are restricted to platform operators (Super Admin).
 * A company that needs an insurer not in the catalog records it as "Other
 * Insurance" — free text on the coverage record — never a fabricated catalog
 * row (spec 5.5).
 *
 * The logo is stored as a URL string (logoUrl), not a binary — the catalog is
 * small reference data and reusing the clinical document store here would be
 * heavier than the requirement ("Insurance Name + Logo").
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    // US state codes this insurer is available in. An insurer may serve several
    // states; the company sees it if any of these intersects its service states.
    states: { type: [{ type: String, enum: US_STATE_CODES }], default: [] },
    logoUrl: { type: String, default: null, trim: true, maxlength: 2000 },
    // Soft on/off without deleting history; inactive entries are hidden from the
    // company picker but retained (a coverage row may still reference one).
    active: { type: Boolean, default: true, index: true },
    notes: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true, versionKey: false, collection: 'insuranceCatalog' },
);
// NOT tenant-scoped — platform-global reference data. Attribution + soft delete
// still apply so we know which operator curated an entry and never hard-delete.
attributionFields(schema, { softDelete: true });
schema.index({ active: 1, states: 1 });
schema.index({ name: 1 });

export const InsuranceCatalog = mongoose.model('InsuranceCatalog', schema);
