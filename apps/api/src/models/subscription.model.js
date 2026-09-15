import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { SUBSCRIPTION_STATUS, BILLING_INTERVAL } from './enums.js';

/**
 * A company's subscription to a plan. Platform-scoped and keyed by
 * organizationId (one active subscription per organization is enforced by the
 * service, not the schema, to allow historical canceled rows).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true, index: true },
    planId: { type: String, required: true },
    // --- Historical snapshot (spec §28) --------------------------------------
    // Captured from the plan at assignment/change time so the company's billing
    // display and any history preserve the amount/name/type that applied THEN.
    // Editing the plan's current price later never rewrites an existing
    // subscription. Nullable for rows created before this field existed — the
    // service falls back to the live plan when a snapshot is absent.
    planName: { type: String, default: null, trim: true },
    unitAmount: { type: Number, default: null, min: 0 }, // minor units, for billingInterval
    currency: { type: String, default: null, lowercase: true, trim: true },
    status: { type: String, enum: SUBSCRIPTION_STATUS, default: 'TRIALING', index: true },
    billingInterval: { type: String, enum: BILLING_INTERVAL, default: 'MONTHLY' },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    trialStart: { type: Date, default: null },
    trialEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    canceledAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'subscription' },
);
schema.index({ organizationId: 1, status: 1 });
attributionFields(schema);

export const Subscription =
  mongoose.models.Subscription || mongoose.model('Subscription', schema);
