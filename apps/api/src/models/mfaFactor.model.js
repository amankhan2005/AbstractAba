import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { MFA_FACTOR_TYPE } from './enums.js';

/** An enrolled second factor. Secret is AES-256-GCM ciphertext. Platform-scoped. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    userId: { type: String, required: true },
    type: { type: String, enum: MFA_FACTOR_TYPE, required: true },
    secretCiphertext: { type: String, required: true },
    label: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    lastUsedCounter: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'mfa_factor' },
);
schema.index({ userId: 1, deletedAt: 1 });

export const MfaFactor = mongoose.model('MfaFactor', schema);
