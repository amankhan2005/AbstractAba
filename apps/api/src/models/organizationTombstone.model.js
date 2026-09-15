import mongoose from 'mongoose';

/** Permanent proof-of-destruction record. Holds no operational data. */
const schema = new mongoose.Schema(
  {
    _id: { type: String }, // = organizationId
    slug: { type: String, required: true },
    createdAt: { type: Date, required: true },
    destroyedAt: { type: Date, required: true },
    destroyedBy: { type: String, required: true },
    approvedBy: { type: String, required: true },
    certificateRef: { type: String, required: true },
  },
  { versionKey: false, collection: 'organization_tombstone' },
);

export const OrganizationTombstone = mongoose.model('OrganizationTombstone', schema);
