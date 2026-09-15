import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { ORGANIZATION_STATE } from './enums.js';

/**
 * Immutable lifecycle transition log. Append-only: the repository never exposes
 * update/delete, and the deployment's application DB role is granted find+insert
 * only on this collection (ARCHITECTURE.md §"Append-only"). Platform-scoped.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    fromState: { type: String, enum: [...ORGANIZATION_STATE, null], default: null },
    toState: { type: String, enum: ORGANIZATION_STATE, required: true },
    reason: { type: String, required: true },
    actorUserId: { type: String, default: null },
    occurredAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: 'organization_state_transition' },
);
schema.index({ organizationId: 1, occurredAt: -1 });

export const OrganizationStateTransition = mongoose.model('OrganizationStateTransition', schema);
