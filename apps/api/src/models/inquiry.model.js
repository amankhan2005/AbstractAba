import mongoose from 'mongoose';
import { newId } from '../utils/id.js';

/**
 * PUBLIC WEBSITE INQUIRY — a "Contact Us" submission from the Abstract ABA
 * marketing website.
 *
 * SCOPE. Platform-level data, deliberately NOT tenant-scoped (no tenantPlugin):
 * an inquiry comes from a prospective organization before any tenant exists and
 * is handled by WebieApp Solutions LLC. It is read and updated only by platform
 * operators (Super Admin) under withPlatform(); company users never reach it.
 *
 * DATA MINIMISATION. Only what the visitor typed into the form plus workflow
 * status. No IP address, user agent or tracking data is stored. `submissionKey`
 * is a one-way digest used to collapse accidental duplicate submissions.
 */
export const INQUIRY_STATUSES = ['NEW', 'CONTACTED', 'CLOSED'];

const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    organization: { type: String, required: true, trim: true, maxlength: 200 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, index: true },
    phone: { type: String, default: null, trim: true, maxlength: 40 },
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    message: { type: String, required: true, maxlength: 5000 },
    status: { type: String, enum: INQUIRY_STATUSES, default: 'NEW', index: true },
    contactedAt: { type: Date, default: null },
    contactedBy: { type: String, default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: String, default: null },
    internalNote: { type: String, default: null, maxlength: 2000 },
    submissionKey: { type: String, required: true, index: true },
  },
  { timestamps: true, versionKey: false, collection: 'inquiry' },
);
schema.index({ createdAt: -1 });

export const Inquiry = mongoose.models.Inquiry || mongoose.model('Inquiry', schema);
