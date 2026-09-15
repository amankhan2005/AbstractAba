import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';

/**
 * Invitation to join an organization. Tenant-owned, but acceptance resolves it
 * by token BEFORE the tenant is known — that read runs under withPlatform()
 * (the original's no-context read path), then re-enters withTenant() once the
 * membership's tenant is resolved. Only the token digest is stored.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    membershipId: { type: String, required: true, unique: true },
    email: { type: String, required: true, lowercase: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    invitedByUserId: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'user_invitation' },
);
schema.plugin(tenantPlugin);

export const UserInvitation = mongoose.model('UserInvitation', schema);
