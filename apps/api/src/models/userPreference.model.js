import mongoose from 'mongoose';

/** Per-user appearance preferences. Platform-scoped, keyed by userId. */
const schema = new mongoose.Schema(
  {
    _id: { type: String }, // = userId
    preferences: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false, collection: 'user_preference' },
);

export const UserPreference = mongoose.model('UserPreference', schema);
