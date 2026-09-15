import mongoose from 'mongoose';
import { newId } from '../utils/id.js';

/**
 * A pre-tenant company invitation. Created by a platform operator with only a
 * contact email (and optional names); the invited company opens a secure link
 * and completes onboarding, which creates the organization.
 *
 * Security mirrors userInvitation: only the SHA-256 token digest is stored, the
 * invitation expires, and it is single-use (consumedAt). It is platform-scoped
 * (no tenant exists yet), so it is read under withPlatform() by token digest.
 */
const companyInvitationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    contactName: { type: String, default: null },
    companyName: { type: String, default: null },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    organizationId: { type: String, default: null }, // set once onboarding creates the org
    invitedByUserId: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: true }, versionKey: false, collection: 'company_invitation' },
);

export const CompanyInvitation =
  mongoose.models.CompanyInvitation || mongoose.model('CompanyInvitation', companyInvitationSchema);
