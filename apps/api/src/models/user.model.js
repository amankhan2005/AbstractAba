import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { USER_STATUS } from './enums.js';

/**
 * Global identity, keyed by email, independent of any organization. Holds no
 * PHI by design — one of the few platform-scoped collections (no tenant plugin).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    emailVerifiedAt: { type: Date, default: null },
    fullName: { type: String, required: true },
    status: { type: String, enum: USER_STATUS, default: 'ACTIVE', index: true },

    permissionsVersion: { type: Number, default: 1 },
    isPlatformOperator: { type: Boolean, default: false },

    passwordHash: { type: String, default: null },
    // Single-use, expiring password-reset token (sha256 hash only — never the raw
    // token). Cleared on consume so a token cannot be replayed.
    passwordResetTokenHash: { type: String, default: null },
    passwordResetExpiresAt: { type: Date, default: null },
    passwordUpdatedAt: { type: Date, default: null },
    // Temporary-credential activation: a server-generated temp password is
    // emailed to a newly provisioned staff member; they authenticate with it and
    // are forced to change it on first login. `mustChangePassword` is true until
    // they do; `firstLoginAt` records the first successful authentication. Both
    // are safe, non-secret account metadata (never a password or token).
    mustChangePassword: { type: Boolean, default: false },
    firstLoginAt: { type: Date, default: null },

    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },

    deletedAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false, collection: 'user' },
);

export const User = mongoose.model('User', schema);
