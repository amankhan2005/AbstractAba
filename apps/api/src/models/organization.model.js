import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { ORGANIZATION_STATE } from './enums.js';

/**
 * The tenant record — the tenancy anchor. It IS the tenant identifier every
 * other collection references via `orgId`, so it carries no orgId of its own
 * and is platform-scoped (no tenant plugin). Cross-tenant enumeration is
 * prevented at the service/authorization layer + the platform-operator gate,
 * the analogue of the original `organization` RLS policy's null-or-match rule.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    legalName: { type: String, required: true },
    tradingName: { type: String, required: true },
    state: { type: String, enum: ORGANIZATION_STATE, default: 'PROVISIONING', index: true },

    countryCode: { type: String, required: true, minlength: 2, maxlength: 2 },
    stateCode: { type: String, default: null },
    // US states this company operates in (spec Module 5.3). Drives which
    // state-specific catalog insurers appear when recording client coverage.
    // A company may serve several states; stateCode remains the legacy single
    // value and is used as a fallback when serviceStates is empty.
    serviceStates: { type: [String], default: [] },
    timezone: { type: String, required: true },
    locale: { type: String, default: 'en-US' },

    primaryContactName: { type: String, required: true },
    primaryContactEmail: { type: String, required: true, lowercase: true, trim: true },

    // Optional public company contact profile — the source for the company
    // email footer. All optional (default null): a footer line is emitted only
    // when its field exists, so a bare org simply shows its name.
    contactPhone: { type: String, default: null, trim: true },
    contactEmail: { type: String, default: null, lowercase: true, trim: true },
    websiteUrl: { type: String, default: null, trim: true },
    addressLine1: { type: String, default: null, trim: true },
    addressLine2: { type: String, default: null, trim: true },
    city: { type: String, default: null, trim: true },
    postalCode: { type: String, default: null, trim: true },

    // Cloudinary secure URL only — the image binary itself is never stored in
    // MongoDB. Set during onboarding (or later, from organization settings);
    // null is a perfectly normal "no logo uploaded yet" state.
    logoUrl: { type: String, default: null },

    planCode: { type: String, default: null },
    placement: { type: mongoose.Schema.Types.Mixed, default: () => ({ mode: 'POOLED' }) },

    kmsKeyArn: { type: String, default: null },
    storagePrefix: { type: String, default: null },
    agreementId: { type: String, default: null },
    // Uniqueness is enforced by a PARTIAL index below, not here. A plain
    // `unique + sparse` path index is wrong for this field: `default: null`
    // materialises `customDomain: null` on every org, and a sparse index only
    // skips ABSENT fields — a present-but-null value is still indexed, so the
    // 2nd org (and every org after it) would collide on the null key (E11000).
    customDomain: { type: String, default: null, lowercase: true },
    parentOrganizationId: { type: String, default: null, index: true },
    destructionGraceDays: { type: Number, default: null },

    activatedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    offboardingAt: { type: Date, default: null },
    destroyedAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'organization' },
);
attributionFields(schema);
schema.index({ createdAt: -1 });
// A custom domain must be unique across the platform WHEN one is set. The
// partial filter restricts the unique constraint to documents whose
// customDomain is an actual string, so the many orgs with no custom domain
// (customDomain: null) never collide. This mirrors the pattern already used by
// claim.generationKey, reconciliationRecord, timeEntry and supervisionHourLog.
schema.index(
  { customDomain: 1 },
  { unique: true, partialFilterExpression: { customDomain: { $type: 'string' } } },
);

export const Organization = mongoose.model('Organization', schema);
