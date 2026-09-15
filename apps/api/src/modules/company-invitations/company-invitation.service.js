import { CompanyInvitation } from '../../models/index.js';
import { invitationTokens, INVITATION_TTL_HOURS, passwords } from '../users/index.js';
import { withPlatform } from '../../tenancy/tenantContext.js';
import { AppError } from '../../common/errors/AppError.js';
import { newId } from '../../utils/id.js';
import { signCloudinaryUpload, isCloudinaryConfigured } from '../../utils/cloudinary.js';

export const COMPANY_INVITATION_DELIVERY_JOB = 'company_invitation.deliver';

/**
 * The agreement a company owner accepts during onboarding, pinned server-side.
 * Onboarding activates a tenant, and the organization state machine will not let
 * a PENDING_AGREEMENT organization reach ACTIVE unless a BUSINESS_ASSOCIATE
 * agreement has been recorded and attached (the HIPAA gate). This descriptor is
 * the single source of truth for WHICH agreement that is: the version and
 * document reference are decided here, never taken from the browser, so a client
 * cannot down-version or mislabel the agreement it accepts. `preview()` surfaces
 * `title`/`version` so the onboarding UI can show the owner exactly what they are
 * agreeing to; the recorded executor is the owner themselves.
 */
export const ONBOARDING_AGREEMENT = Object.freeze({
  type: 'BUSINESS_ASSOCIATE',
  version: '1.0',
  title: 'Business Associate Agreement',
  documentRef: 'baa-v1.0',
});

/**
 * Company invitation lifecycle. An operator invites a company by email; the
 * system issues a secure single-use token (only its digest is stored), enqueues
 * a delivery job through the existing job queue, and later accepts the token to
 * create the organization via the existing organization service.
 *
 * No business logic is duplicated: organization creation is delegated to the
 * organization service, token security to the shared invitationTokens issuer,
 * and delivery to the shared jobQueue.
 */
export class CompanyInvitationService {
  constructor({
    organizationService, jobQueue, usersRepository, cloudinaryConfig = null,
    onboardingService = null, authService = null, ttlHours = INVITATION_TTL_HOURS,
  }) {
    this.organizationService = organizationService;
    this.jobQueue = jobQueue;
    this.usersRepository = usersRepository;
    this.cloudinaryConfig = cloudinaryConfig;
    // onboardingService drives the existing provision → record agreement →
    // countersign → activate lifecycle; authService establishes the auto-login
    // session. Both are optional so the DB-free unit tests that exercise only
    // status derivation / delivery can construct the service without them.
    this.onboardingService = onboardingService;
    this.authService = authService;
    this.ttlHours = ttlHours;
  }

  expiry() {
    return new Date(Date.now() + this.ttlHours * 60 * 60 * 1000);
  }

  /** Operator action: create + issue an invitation and enqueue its delivery. */
  async invite({ email, contactName = null, companyName = null, invitedByUserId }) {
    const { token, tokenHash } = invitationTokens.issue();
    const invitation = await withPlatform(async () =>
      CompanyInvitation.create({
        email: email.toLowerCase().trim(),
        contactName,
        companyName,
        tokenHash,
        expiresAt: this.expiry(),
        invitedByUserId,
      }),
    );

    // Deliver via the existing job architecture. The raw token is passed to the
    // delivery job (to build the link) but is never persisted; only its digest
    // is stored above. tenantId is null — no tenant exists yet.
    await this.jobQueue.enqueue({
      type: COMPANY_INVITATION_DELIVERY_JOB,
      tenantId: null,
      actorId: invitedByUserId,
      payload: { invitationId: invitation._id, email: invitation.email, token, expiresAt: invitation.expiresAt, companyName: invitation.companyName, contactName: invitation.contactName },
      idempotencyKey: `company-invite:${invitation._id}`,
    });

    return this.toSummary(invitation);
  }

  /** Operator action: list invitations, optionally by status. */
  async list({ status } = {}) {
    return withPlatform(async () => {
      const all = await CompanyInvitation.find({}).sort({ createdAt: -1 }).lean();
      const mapped = all.map((i) => this.toSummary(i));
      if (!status) return mapped;
      return mapped.filter((i) => i.status === status);
    });
  }

  /** Operator action: resend — re-enqueue delivery with a fresh token + expiry. */
  async resend(invitationId, actorUserId) {
    return withPlatform(async () => {
      const invitation = await CompanyInvitation.findById(invitationId);
      if (!invitation) throw AppError.notFound('COMPANY_INVITE-404', 'Invitation not found');
      if (invitation.consumedAt || invitation.revokedAt) {
        throw AppError.conflict('COMPANY_INVITE-409', 'That invitation is no longer active.');
      }
      const { token, tokenHash } = invitationTokens.issue();
      invitation.tokenHash = tokenHash;
      invitation.expiresAt = this.expiry();
      await invitation.save();
      await this.jobQueue.enqueue({
        type: COMPANY_INVITATION_DELIVERY_JOB,
        tenantId: null,
        actorId: actorUserId,
        payload: { invitationId: invitation._id, email: invitation.email, token, expiresAt: invitation.expiresAt, companyName: invitation.companyName, contactName: invitation.contactName },
        idempotencyKey: `company-invite:${invitation._id}:${invitation.expiresAt.getTime()}`,
      });
      return this.toSummary(invitation);
    });
  }

  /** Operator action: revoke a pending invitation. */
  async revoke(invitationId) {
    return withPlatform(async () => {
      const invitation = await CompanyInvitation.findById(invitationId);
      if (!invitation) throw AppError.notFound('COMPANY_INVITE-404', 'Invitation not found');
      if (invitation.consumedAt) {
        throw AppError.conflict('COMPANY_INVITE-409', 'That invitation was already used.');
      }
      invitation.revokedAt = new Date();
      await invitation.save();
      return this.toSummary(invitation);
    });
  }

  /**
   * Public: resolve an invitation token for the onboarding page. Unknown,
   * expired, revoked and consumed all fail identically — no oracle.
   */
  async preview(token) {
    const invitation = await this.resolveActive(token);
    return {
      email: invitation.email,
      contactName: invitation.contactName,
      companyName: invitation.companyName,
      expiresAt: invitation.expiresAt,
      // What the owner will be asked to accept on the final onboarding step, so
      // the UI can render the correct agreement label/version (never the token).
      agreement: { type: ONBOARDING_AGREEMENT.type, version: ONBOARDING_AGREEMENT.version, title: ONBOARDING_AGREEMENT.title },
    };
  }

  /**
   * Public: hand out a short-lived, narrowly-scoped Cloudinary upload
   * signature for the onboarding form's logo step. Gated by the same valid
   * invitation token as preview()/accept() — you cannot get an upload slot
   * without a live invitation link, and the signed folder is derived from the
   * token digest so one invitation can never be used to sign uploads into
   * another company's logo folder. The image itself never touches this
   * server; the browser uploads directly to Cloudinary with this signature,
   * and only the resulting secure_url is later submitted as part of accept().
   */
  async logoUploadSignature(token) {
    if (!isCloudinaryConfigured(this.cloudinaryConfig)) {
      throw new AppError('CLOUDINARY-503', { status: 503, message: 'Logo upload is not configured on this environment.' });
    }
    await this.resolveActive(token); // throws if invalid/expired — same guarantee as preview()
    const folder = `company-onboarding-logos/${invitationTokens.hash(token).slice(0, 24)}`;
    return signCloudinaryUpload(this.cloudinaryConfig, { folder });
  }

  /**
   * Public: accept an invitation by submitting the company details AND the
   * owner's chosen password. Creates the organization via the existing
   * organization service, then creates the owner's login (global user row +
   * ACTIVE, isOwner membership, 'owner' system role) via the users repository,
   * and marks the invitation consumed (single-use). The submitted primary
   * contact defaults to the invited email when the form leaves it blank; that
   * same email becomes the owner's login email.
   *
   * If owner-account creation fails after the organization was created, the
   * organization is left in PROVISIONING and the invitation is NOT consumed —
   * the token still resolves so the person can retry rather than being locked
   * out by a partial failure.
   */
  async accept(token, details, ctx = {}) {
    const invitation = await this.resolveActive(token);
    const { password, agreement, ...orgDetails } = details;

    // The agreement acceptance is the gate. If the owner did not explicitly
    // accept, we reject BEFORE any side effect — the organization is never
    // created and nothing is activated. This is the safe failure the state
    // machine would otherwise enforce later as AGREEMENT_REQUIRED; catching it
    // up front keeps a half-provisioned tenant from being left behind.
    if (!agreement || agreement.accepted !== true) {
      throw AppError.validation('You must accept the required agreement to complete setup.', [
        { path: 'body.agreement.accepted', message: 'Required' },
      ]);
    }

    passwords.assertAcceptable(password, { email: invitation.email });
    const ownerEmail = (orgDetails.primaryContactEmail ?? invitation.email).toLowerCase().trim();
    // The platform actor for the compliance steps is the operator who issued
    // this invitation — read from the stored invitation, NEVER from the request
    // body. Inviting the company is the platform's authorization to activate it;
    // that operator's id is what countersigns the agreement and records the
    // activation transition in the audit trail.
    const operatorUserId = invitation.invitedByUserId;

    // 1. Create the organization (PROVISIONING). logoUrl, if the form uploaded a
    //    logo, rides through orgDetails and is persisted to the org's branding.
    const org = await this.organizationService.create({
      ...orgDetails,
      primaryContactEmail: ownerEmail,
    });

    // 2. Create the owner's login: an ACTIVE user with an ACTIVE, isOwner
    //    membership under the 'owner' role. tenantId is the org WE just created,
    //    never a client-supplied value.
    const passwordHash = await passwords.hash(password);
    await this.usersRepository.createOwnerAccount({
      userId: newId(),
      membershipId: newId(),
      tenantId: org.id,
      email: ownerEmail,
      fullName: orgDetails.primaryContactName,
      passwordHash,
    });

    // 3. Provision the tenant (idempotent): PROVISIONING → PENDING_AGREEMENT.
    await this.onboardingService.provision({ organizationId: org.id, actorUserId: operatorUserId });

    // 4. Record the executed business-associate agreement the owner accepted.
    //    The executor is the owner; the version/document reference are pinned
    //    server-side (ONBOARDING_AGREEMENT), not taken from the browser. Reused
    //    on retry so a partial replay cannot create a duplicate agreement.
    const recorded = await this._recordOrFindAgreement({
      organizationId: org.id,
      executedByName: orgDetails.primaryContactName,
      executedByTitle: agreement.acceptedByTitle,
      executedIp: ctx.requestIp ?? null,
      actorUserId: operatorUserId,
    });

    // 5. Countersign on the platform's authority → attaches agreementId to the
    //    organization, which is exactly what unlocks activation in the state
    //    machine. Skipped if a prior attempt already countersigned it.
    if (!recorded.countersignedAt) {
      await this.onboardingService.countersignAgreement({
        organizationId: org.id, agreementId: recorded.id, actorUserId: operatorUserId,
      });
    }

    // 6. Activate PENDING_AGREEMENT → ACTIVE using the CURRENT version (optimistic
    //    concurrency). The gate is enforced by the state machine, not bypassed:
    //    with the agreement now attached, AGREEMENT_REQUIRED no longer fires and
    //    the transition succeeds. If a prior attempt already activated, skip.
    const fresh = await this.organizationService.getById(org.id);
    const activated = fresh.state === 'ACTIVE'
      ? fresh
      : await this.onboardingService.activate({
          organizationId: org.id, actorUserId: operatorUserId, expectedVersion: fresh.version,
        });

    // 7. Consume the invitation (single-use) only after activation succeeds, so a
    //    failure anywhere above leaves the token live for a safe retry.
    await withPlatform(async () => {
      invitation.consumedAt = new Date();
      invitation.organizationId = org.id;
      await invitation.save();
    });

    // 8. Establish the auto-login session (same issuance as sign-in). If it
    //    fails, we DO NOT fabricate one — the owner is asked to sign in. The
    //    account and organization are already fully set up, so signing in works.
    let session = null;
    if (this.authService) {
      try {
        session = await this.authService.establishSessionForEmail(ownerEmail, {
          userAgent: ctx.userAgent ?? null, ipAddress: ctx.requestIp ?? null,
        });
      } catch {
        session = null;
      }
    }

    return { organizationId: org.id, state: activated.state, session };
  }

  /**
   * Records the onboarding agreement, or returns the existing one when a prior
   * attempt already recorded it (the unique (organizationId, type, version)
   * index would otherwise reject a replay). Keeps accept() convergent on retry.
   */
  async _recordOrFindAgreement({ organizationId, executedByName, executedByTitle, executedIp, actorUserId }) {
    const existing = (await this.onboardingService.listAgreements(organizationId))
      .find((a) => a.type === ONBOARDING_AGREEMENT.type && a.version === ONBOARDING_AGREEMENT.version);
    if (existing) return existing;
    return this.onboardingService.recordAgreement({
      organizationId,
      type: ONBOARDING_AGREEMENT.type,
      version: ONBOARDING_AGREEMENT.version,
      executedByName,
      executedByTitle,
      executedAt: new Date(),
      executedIp,
      documentRef: ONBOARDING_AGREEMENT.documentRef,
      actorUserId,
    });
  }

  async resolveActive(token) {
    const tokenHash = invitationTokens.hash(token);
    const invitation = await withPlatform(async () => CompanyInvitation.findOne({ tokenHash }));
    const active =
      invitation &&
      invitation.consumedAt === null &&
      invitation.revokedAt === null &&
      new Date(invitation.expiresAt).getTime() > Date.now();
    if (!active) throw AppError.notFound('COMPANY_INVITE-404', 'This invitation is invalid or has expired.');
    return invitation;
  }

  toSummary(i) {
    const now = Date.now();
    const status = i.consumedAt
      ? 'ACCEPTED'
      : i.revokedAt
      ? 'REVOKED'
      : new Date(i.expiresAt).getTime() <= now
      ? 'EXPIRED'
      : 'PENDING';
    return {
      id: i._id,
      email: i.email,
      contactName: i.contactName ?? null,
      companyName: i.companyName ?? null,
      status,
      expiresAt: i.expiresAt,
      organizationId: i.organizationId ?? null,
      createdAt: i.createdAt,
    };
  }
}
