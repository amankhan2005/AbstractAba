import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { BILLING_INTERVAL } from './enums.js';

/**
 * A subscription plan Abstract ABA offers to companies. Platform-scoped (operator
 * owned) — not tenant data. Money is stored in integer minor units (cents).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    code: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: null },
    monthlyPrice: { type: Number, required: true, min: 0 }, // minor units
    yearlyPrice: { type: Number, required: true, min: 0 }, // minor units
    currency: { type: String, default: 'usd', lowercase: true, trim: true },
    interval: { type: String, enum: BILLING_INTERVAL, default: 'MONTHLY' },
    trialDays: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true, index: true },
    features: { type: [String], default: [] },
    limits: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false, collection: 'subscription_plan' },
);
attributionFields(schema);

export const SubscriptionPlan =
  mongoose.models.SubscriptionPlan || mongoose.model('SubscriptionPlan', schema);
