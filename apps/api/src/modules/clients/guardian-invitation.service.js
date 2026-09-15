import { GuardianInvitation, Guardian, Client, Organization } from '../../models/index.js';
import { withTenant, withPlatform } from '../../tenancy/tenantContext.js';
import { randomToken, sha256Hex } from '../../utils/crypto.js';
import { AppError } from '../../common/errors/AppError.js';
import { env } from '../../config/env.js';
import { guardianInvitationEmail } from './guardian-invitation.email.js';

/**
 * ---------------------------------------------------------------------------
 * GUARDIAN INVITATION SERVICE — blueprint §2.6 / §6.2.
 *
 * A guardian is invited to supply information about ONE child, once. There is
 * no account, no password, no portal — §2.6 excludes a family portal, and §5.1
 * records that the underlying need (visibility and signature) is met without
 * one.
 *
 * SECURITY POSTURE, and why each part is the way it is:
 *
 *   The raw token is generated here, hashed immediately, and returned to the
 *   caller exactly once so the mailer can put it in a link. It is never
 *   stored, never logged, and never included in an API response body.
 *
 *   `resolve` is the ONLY anonymous entry point in the tenant application, so
 *   it is deliberately narrow: it returns the child's first name, the clinic's
 *   name and branding, and what is being asked for. It does NOT return the
 *   client id, the tenant id, other guardians, clinical content, or anything
 *   about other children.
 *
 *   Every failure — unknown, expired, revoked, already used — returns the SAME
 *   shape and a message that does not distinguish them. Distinguishing lets
 *   someone with a list of guesses learn which tokens exist.
 *
 * DELIVERY HONESTY. `deliveryStatus` is set from the transport's actual result.
 * A Resend failure is recorded as FAILED with the reason, and the API reports
 * it. The blueprint's requirement — never show "sent" when the transport failed
 * — cannot be met by a fire-and-forget send.
 * ---------------------------------------------------------------------------
 */

/** Invitations are valid for 14 days: long enough for a family, short enough to matter. */
const TTL_DAYS = 14;

/** A deliberately indistinguishable failure for every bad-token case. */
function invalidLink() {
  return AppError.notFound(
    'GUARDIAN-404',
    'This link is no longer valid. Please ask the clinic to send you a new one.',
  );
}

export class GuardianInvitationService {
  constructor(deps = {}) {
    // The transport is injected so tests can assert delivery behaviour without
    // a network, and so a failure is observable rather than swallowed.
    this.deps = deps;
  }

  transport() {
    return this.deps.transport ?? null;
  }

  /**
   * Issue an invitation for one guardian of one child and attempt delivery.
   *
   * Returns the invitation WITHOUT the token. The caller learns whether
   * delivery succeeded, not what the link was.
   */
  async invite({ tenantId, clientId, guardianId, actorUserId }) {
    const { invitation, rawToken, guardian, client, organization } = await withTenant(tenantId, async () => {
      const g = await Guardian.findOne({ _id: guardianId, clientId, deletedAt: null }).lean();
      if (!g) throw AppError.notFound('GUARDIAN-404', 'We couldn\u2019t find that guardian.');
      if (!g.email) {
        throw AppError.validation('Add an email address for this guardian before sending them a request.');
      }

      const c = await Client.findOne({ _id: clientId, deletedAt: null }).lean();
      if (!c) throw AppError.notFound('CLIENT-404', 'We couldn\u2019t find that client.');

      // Supersede any outstanding invitation for this guardian. Two live links
      // to the same record is one more than anybody needs, and the older one
      // usually reaches a stale inbox.
      await GuardianInvitation.updateMany(
        { clientId, guardianId, consumedAt: null, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );

      const token = randomToken(32);
      const doc = await GuardianInvitation.create({
        clientId,
        guardianId,
        organizationId: tenantId,
        email: g.email,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000),
        invitedByUserId: actorUserId,
        deliveryStatus: 'PENDING',
      });

      const org = await withPlatform(() => Organization.findById(tenantId).lean());
      return { invitation: doc, rawToken: token, guardian: g, client: c, organization: org };
    });

    const delivered = await this._deliver({
      tenantId,
      invitation,
      rawToken,
      guardian,
      client,
      organization,
    });
    return delivered;
  }

  /** Re-send an existing invitation, issuing a fresh token and expiry. */
  async resend({ tenantId, clientId, invitationId, actorUserId }) {
    const { invitation, rawToken, guardian, client, organization } = await withTenant(tenantId, async () => {
      const inv = await GuardianInvitation.findOne({ _id: invitationId, clientId });
      if (!inv) throw AppError.notFound('GUARDIAN-404', 'We couldn\u2019t find that request.');
      if (inv.consumedAt) {
        throw AppError.conflict('GUARDIAN-409', 'This family has already sent their information.');
      }

      // A resend ROTATES the token. Re-mailing the old one would leave two
      // live links, and would mean a link exposed in a forwarded email stays
      // live even after the clinic "reissued" it.
      const token = randomToken(32);
      inv.tokenHash = sha256Hex(token);
      inv.expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
      inv.revokedAt = null;
      inv.deliveryStatus = 'PENDING';
      inv.deliveryError = null;
      inv.updatedBy = actorUserId;
      await inv.save();

      const g = await Guardian.findOne({ _id: inv.guardianId }).lean();
      const c = await Client.findOne({ _id: clientId }).lean();
      const org = await withPlatform(() => Organization.findById(tenantId).lean());
      return { invitation: inv, rawToken: token, guardian: g, client: c, organization: org };
    });

    return this._deliver({ tenantId, invitation, rawToken, guardian, client, organization });
  }

  async revoke({ tenantId, clientId, invitationId }) {
    return withTenant(tenantId, async () => {
      const inv = await GuardianInvitation.findOne({ _id: invitationId, clientId });
      if (!inv) throw AppError.notFound('GUARDIAN-404', 'We couldn\u2019t find that request.');
      inv.revokedAt = new Date();
      await inv.save();
      return toInvitation(inv.toObject());
    });
  }

  /** Outstanding and past requests for a child, for the clinic-side UI. */
  async listForClient({ tenantId, clientId }) {
    return withTenant(tenantId, async () => {
      const rows = await GuardianInvitation.find({ clientId }).sort({ createdAt: -1 }).lean();
      return rows.map(toInvitation);
    });
  }

  /**
   * ANONYMOUS. Resolve a raw token to the minimum a guardian needs to see.
   *
   * Runs under withPlatform because the caller has no session and no tenant;
   * the record itself names the organization, and everything after this point
   * re-enters that tenant's context.
   */
  async resolve(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length < 20) throw invalidLink();

    const inv = await withPlatform(async () =>
      GuardianInvitation.findOne({ tokenHash: sha256Hex(rawToken) }).lean());

    // One failure for every cause: unknown, expired, revoked, already used.
    if (!inv) throw invalidLink();
    if (inv.revokedAt || inv.consumedAt) throw invalidLink();
    if (new Date() > new Date(inv.expiresAt)) throw invalidLink();

    return withTenant(inv.organizationId, async () => {
      const client = await Client.findById(inv.clientId).lean();
      const org = await withPlatform(() => Organization.findById(inv.organizationId).lean());
      if (!client) throw invalidLink();

      // The narrowest useful projection. A first name so the family knows the
      // form is about the right child; a clinic name so they know who is
      // asking. No identifiers, no clinical content, no other children.
      return {
        childFirstName: client.firstName,
        organizationName: org?.name ?? 'your clinic',
        branding: org?.branding ?? null,
        expiresAt: inv.expiresAt,
      };
    });
  }

  /**
   * ANONYMOUS. Accept the guardian's submission and close the link.
   *
   * The submission updates the GUARDIAN's own contact details only. A guardian
   * cannot reach clinical fields, cannot change the child's record, and cannot
   * assert an insurance verification — recording a verification is a staff act
   * (`clients.verify_insurance`), and letting a family assert it would put the
   * scheduling gate in the hands of the people it exists to protect.
   */
  async submit(rawToken, payload) {
    if (typeof rawToken !== 'string' || rawToken.length < 20) throw invalidLink();
    const tokenHash = sha256Hex(rawToken);

    const inv = await withPlatform(async () => GuardianInvitation.findOne({ tokenHash }).lean());
    if (!inv || inv.revokedAt || inv.consumedAt) throw invalidLink();
    if (new Date() > new Date(inv.expiresAt)) throw invalidLink();

    return withTenant(inv.organizationId, async () => {
      // Consume FIRST, guarded on still-unconsumed, so two concurrent
      // submissions cannot both proceed. The write is the lock.
      const consumed = await GuardianInvitation.findOneAndUpdate(
        { _id: inv._id, consumedAt: null, revokedAt: null },
        { $set: { consumedAt: new Date() } },
        { new: true },
      );
      if (!consumed) throw invalidLink();

      const guardian = await Guardian.findById(inv.guardianId);
      if (!guardian) throw invalidLink();

      // An allowlist, not a spread. A guardian may correct how the clinic
      // reaches them and nothing else.
      for (const field of ['phone', 'email', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode']) {
        if (payload[field] !== undefined) guardian[field] = payload[field];
      }
      await guardian.save();

      return { submitted: true };
    });
  }

  // --- delivery ------------------------------------------------------------

  /**
   * Attempts delivery and records the ACTUAL outcome.
   *
   * Never throws on a transport failure: the invitation exists and is valid,
   * and the clinic's next move is to resend or check the address — not to see
   * the whole action fail. The failure is returned in the response so the UI
   * can say "we couldn't send this" instead of "sent".
   */
  async _deliver({ tenantId, invitation, rawToken, guardian, client, organization }) {
    const transport = this.transport();
    const link = `${env.webAppUrl}/guardian/${encodeURIComponent(rawToken)}`;

    const view = guardianInvitationEmail({
      organizationName: organization?.name ?? 'your clinic',
      childFirstName: client?.firstName ?? 'your child',
      guardianFirstName: guardian?.firstName ?? null,
      link,
      expiresAt: invitation.expiresAt,
    });

    let status = 'FAILED';
    let error = 'Email is not configured on this server.';

    if (transport) {
      try {
        await transport.send({ recipientEmail: guardian.email, view });
        status = 'SENT';
        error = null;
      } catch (err) {
        // The message may name the transport; it must never carry the token,
        // and the token is not in scope for this string.
        error = String(err?.message ?? 'Delivery failed').slice(0, 500);
      }
    }

    return withTenant(tenantId, async () => {
      const updated = await GuardianInvitation.findByIdAndUpdate(
        invitation._id,
        {
          $set: {
            deliveryStatus: status,
            deliveryError: error,
            ...(status === 'SENT' ? { sentAt: new Date() } : {}),
          },
          $inc: { sendAttempts: 1 },
        },
        { new: true },
      ).lean();
      return toInvitation(updated);
    });
  }
}

/**
 * Response shape. Deliberately omits `tokenHash` — a digest is not a secret,
 * but there is no reason for it to leave the server, and its presence in a
 * response invites someone to treat it as an identifier.
 */
export function toInvitation(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    clientId: doc.clientId,
    guardianId: doc.guardianId,
    email: doc.email,
    expiresAt: doc.expiresAt ?? null,
    consumedAt: doc.consumedAt ?? null,
    revokedAt: doc.revokedAt ?? null,
    deliveryStatus: doc.deliveryStatus ?? 'PENDING',
    deliveryError: doc.deliveryError ?? null,
    sentAt: doc.sentAt ?? null,
    sendAttempts: doc.sendAttempts ?? 0,
    status: derivedStatus(doc),
  };
}

/** The single state the UI renders, collapsing the flags into one answer. */
export function derivedStatus(doc) {
  if (doc.consumedAt) return 'COMPLETED';
  if (doc.revokedAt) return 'REVOKED';
  if (doc.expiresAt && new Date() > new Date(doc.expiresAt)) return 'EXPIRED';
  if (doc.deliveryStatus === 'FAILED') return 'FAILED';
  if (doc.deliveryStatus === 'SENT') return 'SENT';
  return 'PENDING';
}
