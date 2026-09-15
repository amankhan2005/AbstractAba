import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';

/**
 * ---------------------------------------------------------------------------
 * GUARDIAN INVITATION — blueprint §2.6 and §6.2.
 *
 * The blueprint is explicit that there is NO parent portal in this version:
 * §2.6 lists a family portal among the deliberate exclusions, and §5.1 notes
 * "the underlying need — visibility and signature — is met without it". So
 * this is not an account. It is a one-time, scoped invitation for a guardian to
 * supply the information the clinic needs from them, and nothing else.
 *
 * That distinction drives every design decision here:
 *
 *   No user, no membership, no password. Creating an account would create a
 *   fourth authentication surface the blueprint deliberately excluded, and a
 *   standing credential to a PHI system for someone who needs it once.
 *
 *   The token grants access to ONE child's intake fields — never a client
 *   list, never clinical content, never other children in the same family
 *   unless separately invited.
 *
 *   Only the DIGEST is stored, exactly as UserInvitation does. A database
 *   disclosure must not yield usable links. The raw token exists only in the
 *   email.
 *
 *   Single-use and expiring. `consumedAt` closes it permanently; a link that
 *   still works after the guardian has submitted is a link that works for
 *   whoever later reads the family's inbox.
 *
 * Resolution happens BEFORE the tenant is known — the guardian is anonymous at
 * that point — so the lookup runs under withPlatform() and re-enters
 * withTenant() once this record names the organization. Same pattern as
 * UserInvitation.
 * ---------------------------------------------------------------------------
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },

    clientId: { type: String, required: true, index: true },
    guardianId: { type: String, required: true, index: true },
    // Denormalised so the anonymous pre-tenant lookup can re-enter the right
    // tenant context without a second query against a tenant-scoped model.
    organizationId: { type: String, required: true, index: true },

    email: { type: String, required: true, lowercase: true, trim: true },

    // SHA-256 of the raw token. The raw value is returned once, to the mailer.
    tokenHash: { type: String, required: true, unique: true },

    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },

    invitedByUserId: { type: String, required: true },

    // Delivery state, so the UI can distinguish "we sent it" from "we tried".
    // Blueprint requirement: never show "sent" when the transport failed.
    deliveryStatus: {
      type: String,
      enum: ['PENDING', 'SENT', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    deliveryError: { type: String, default: null, maxlength: 500 },
    sentAt: { type: Date, default: null },
    // Counts resends so a support conversation can distinguish "never
    // arrived" from "sent four times to a mistyped address".
    sendAttempts: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: true }, versionKey: false, collection: 'guardian_invitation' },
);

schema.plugin(tenantPlugin);
schema.index({ tenantId: 1, clientId: 1, consumedAt: 1 });
// Expiry sweep.
schema.index({ expiresAt: 1 });

export const GuardianInvitation = mongoose.model('GuardianInvitation', schema);
