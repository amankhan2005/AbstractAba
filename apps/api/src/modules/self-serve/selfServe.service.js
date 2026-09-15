import { recordSafely } from '../audit/audit.service.js';

/**
 * Self-serve clinic signup (BR-3). This is ORCHESTRATION ONLY — it composes the
 * existing organization, onboarding/provisioning, and users services. It adds no
 * new persistence model and duplicates none of their logic. The sequence mirrors
 * exactly what a platform operator does today, minus the countersign+activate
 * step, which remains operator-only so the agreement gate is preserved:
 *
 *   1. organizations.create()          → org in PROVISIONING (slug uniqueness enforced)
 *   2. onboarding.provision()          → runs provisioning → PENDING_AGREEMENT
 *   3. onboarding.recordAgreement()    → records the BAA the signer accepted
 *   4. users.inviteInitialOwner()      → issues the first-owner invitation
 *
 * The organization ends at PENDING_AGREEMENT. It CANNOT serve clinical data and
 * CANNOT self-activate: an operator still countersigns the agreement and
 * activates. Self-serve removes the manual data entry, not the gate.
 */
export class SelfServeService {
  constructor(deps) {
    this.deps = deps; // { organizations, onboarding, users }
  }

  async signup({ input, requestIp }) {
    // 1. Create the organization (PROVISIONING). Slug collision → 409 from the
    //    existing service; we never trust a client-supplied tenant id or state.
    const organization = await this.deps.organizations.create({
      slug: input.slug,
      legalName: input.legalName,
      tradingName: input.tradingName,
      countryCode: input.countryCode.toUpperCase(),
      ...(input.stateCode ? { stateCode: input.stateCode } : {}),
      ...(input.serviceStates ? { serviceStates: input.serviceStates } : {}),
      timezone: input.timezone,
      primaryContactName: input.ownerFullName,
      primaryContactEmail: input.ownerEmail.toLowerCase(),
    });

    // 2. Provision (idempotent, server-authoritative) → PENDING_AGREEMENT.
    //    actorUserId is null: this is a system-initiated self-serve action.
    await this.deps.onboarding.provision({ organizationId: organization.id, actorUserId: null });

    // 3. Record the business-associate agreement the signer accepted. The org
    //    stays PENDING_AGREEMENT — activation still needs an operator countersign.
    await this.deps.onboarding.recordAgreement({
      organizationId: organization.id,
      type: 'BUSINESS_ASSOCIATE',
      version: input.agreement.version,
      executedByName: input.agreement.acceptedByName,
      executedByTitle: input.agreement.acceptedByTitle,
      executedAt: new Date(),
      executedIp: requestIp ?? null,
      documentRef: null,
      actorUserId: null,
    });

    // 4. Invite the first owner (issues an invitation + token via the existing
    //    flow, which sends the acceptance email through the configured transport).
    const invitation = await this.deps.users.inviteInitialOwner({
      organizationId: organization.id,
      email: input.ownerEmail.toLowerCase(),
      fullName: input.ownerFullName,
      invitedByUserId: null,
    });

    recordSafely({
      tenantId: organization.id,
      actorId: null,
      action: 'organization.self_serve_signup',
      entityType: 'organization',
      entityId: organization.id,
      outcome: 'success',
      payload: { slug: organization.slug, state: 'PENDING_AGREEMENT' },
    });

    // Return only non-sensitive confirmation. Never leak the invitation token in
    // the API response — it is delivered out-of-band by the invitation email.
    return {
      organizationId: organization.id,
      slug: organization.slug,
      state: 'PENDING_AGREEMENT',
      ownerEmail: input.ownerEmail.toLowerCase(),
      nextStep: 'Check your email to accept your owner invitation. Your clinic will be activated once your agreement is countersigned.',
      invitationId: invitation?.invitation?.id ?? invitation?.id ?? null,
    };
  }
}
