import mongoose from 'mongoose';
import { newId } from '../utils/id.js';

/** Single-use, short-lived, stored hashed. Platform-scoped. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    userId: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null },
    ipAddress: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'password_reset_token' },
);
schema.index({ userId: 1, usedAt: 1 });

export const PasswordResetToken = mongoose.model('PasswordResetToken', schema);
