import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { SESSION_REVOCATION_REASON } from './enums.js';

/** One refresh token and the rotation family it belongs to. Platform-scoped. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    userId: { type: String, required: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    activeTenantId: { type: String, default: null },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, enum: SESSION_REVOCATION_REASON, default: null },
    replacedBySessionId: { type: String, default: null },
    userAgent: { type: String, default: null },
    ipAddress: { type: String, default: null },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'auth_session' },
);
schema.index({ userId: 1, revokedAt: 1 });

export const AuthSession = mongoose.model('AuthSession', schema);
