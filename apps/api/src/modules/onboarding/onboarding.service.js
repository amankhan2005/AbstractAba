import { onboardingError } from './onboarding.errors.js';

/**
 * The onboarding lifecycle of a clinic: provision, agree, activate — and, at the
 * other end, offboard, export, destroy. Ported from the original. The rules make
 * one thing structurally impossible: storing clinical data for an organization
 * whose business associate agreement has not been executed and countersigned.
 * The agreement gate itself lives in the organization state machine; onboarding
 * sequences around it.
 */
export class OnboardingService {
  constructor(deps) {
    this.deps = deps;
  }

  /** Runs provisioning; advances to PENDING_AGREEMENT only when every step succeeds. */
  async provision(input) {
    const organization = await this.deps.organizations.getById(input.organizationId);
    if (organization.state !== 'PROVISIONING') {
      throw onboardingError('ILLEGAL_STATE_TRANSITION', {
        message: 'Provisioning only applies to an organization that is still being set up.',
        context: { state: organization.state },
      });
    }
    const outcome = await this.deps.provisioning.run(input.organizationId);
    if (outcome.complete) {
      await this.deps.organizations.transition({
        organizationId: organization.id,
        toState: 'PENDING_AGREEMENT',
        reason: 'Provisioning completed; awaiting the business associate agreement',
        actorUserId: input.actorUserId,
        expectedVersion: organization.version,
      });
    }
    return this.checklist(input.organizationId);
  }

  async recordAgreement(input) {
    const organization = await this.deps.organizations.getById(input.organizationId);
    if (organization.state === 'DESTROYED') {
      throw onboardingError('ILLEGAL_STATE_TRANSITION', { message: 'That organization no longer exists.' });
    }
    if (input.executedAt.getTime() > Date.now()) {
      throw onboardingError('VALIDATION_FAILED', {
        details: [{ path: 'body.executedAt', message: 'An agreement cannot be executed in the future' }],
      });
    }
    return this.deps.repository.createAgreement({
      id: this.deps.newId(),
      organizationId: input.organizationId,
      type: input.type,
      version: input.version,
      executedByName: input.executedByName,
      executedByTitle: input.executedByTitle,
      executedAt: input.executedAt,
      executedIp: input.executedIp,
      documentRef: input.documentRef,
      createdBy: input.actorUserId,
    });
  }

  /** Countersigns; a business associate agreement is then attached to the org (unlocks activation). */
  async countersignAgreement(input) {
    const agreements = await this.deps.repository.findAgreements(input.organizationId);
    const agreement = agreements.find((a) => a.id === input.agreementId);
    if (!agreement) throw onboardingError('NOT_FOUND');
    if (agreement.countersignedAt !== null) {
      throw onboardingError('CONFLICT', { message: 'That agreement has already been countersigned.' });
    }
    const countersigned = await this.deps.repository.countersignAgreement({ agreementId: agreement.id, userId: input.actorUserId });
    if (agreement.type === 'BUSINESS_ASSOCIATE') {
      await this.deps.repository.attachAgreementToOrganization({ organizationId: input.organizationId, agreementId: agreement.id });
    }
    return countersigned;
  }

  listAgreements(organizationId) {
    return this.deps.repository.findAgreements(organizationId);
  }

  /** The onboarding state of one organization, as an operator sees it (a checklist). */
  async checklist(organizationId) {
    const organization = await this.deps.organizations.getById(organizationId);
    const steps = await this.deps.repository.listProvisioningSteps(organizationId);
    const agreements = await this.deps.repository.findAgreements(organizationId);

    const businessAssociate = agreements.find((a) => a.type === 'BUSINESS_ASSOCIATE' && a.countersignedAt !== null);
    const provisioningComplete = steps.length > 0 && steps.every((s) => s.state === 'COMPLETED');

    const checklistSteps = [
      ...steps.map((s) => ({
        key: s.stepKey,
        label: OnboardingService.labelFor(s.stepKey),
        complete: s.state === 'COMPLETED',
        blocking: true,
        detail: s.detail,
      })),
      {
        key: 'business_associate_agreement',
        label: 'Business associate agreement executed and countersigned',
        complete: businessAssociate !== undefined,
        blocking: true,
        detail: null,
      },
    ];

    const readyToActivate =
      organization.state === 'PENDING_AGREEMENT' && provisioningComplete && businessAssociate !== undefined;

    return {
      organizationId,
      state: organization.state,
      steps: checklistSteps,
      nextAction: OnboardingService.nextAction(organization, provisioningComplete, readyToActivate),
      readyToActivate,
    };
  }

  /** Activates — the agreement gate is enforced by the organization state machine, not duplicated here. */
  activate(input) {
    return this.deps.organizations.transition({
      organizationId: input.organizationId,
      toState: 'ACTIVE',
      reason: 'Onboarding completed; business associate agreement in force',
      actorUserId: input.actorUserId,
      expectedVersion: input.expectedVersion,
    });
  }

  // --- offboarding ----------------------------------------------------------

  async beginOffboarding(input) {
    const organization = await this.deps.organizations.transition({
      organizationId: input.organizationId,
      toState: 'OFFBOARDING',
      reason: input.reason,
      actorUserId: input.actorUserId,
      expectedVersion: input.expectedVersion,
    });
    const created = await this.deps.repository.createExport({
      id: this.deps.newId(),
      organizationId: input.organizationId,
      requestedByUserId: input.actorUserId,
    });
    return { organization, export: created };
  }

  completeExport(input) {
    return this.deps.repository.updateExportState({
      exportId: input.exportId,
      state: 'AVAILABLE',
      artifactRef: input.artifactRef,
      expiresAt: new Date(Date.now() + this.deps.exportTtlHours * 60 * 60 * 1000),
    });
  }

  latestExport(organizationId) {
    return this.deps.repository.findLatestExport(organizationId);
  }

  /** Approves destruction; export-completed is derived and passed to the state machine's guard. */
  async approveDestruction(input) {
    const latest = await this.deps.repository.findLatestExport(input.organizationId);
    const exportCompleted = latest !== null && (latest.state === 'AVAILABLE' || latest.state === 'DOWNLOADED');
    return this.deps.organizations.transition({
      organizationId: input.organizationId,
      toState: 'DESTROYED',
      reason: 'Destruction approved after export and grace period',
      actorUserId: input.approvedByUserId,
      expectedVersion: input.expectedVersion,
      destruction: { requestedByUserId: input.requestedByUserId, exportCompleted },
    });
  }

  // --- helpers --------------------------------------------------------------

  static labelFor(stepKey) {
    switch (stepKey) {
      case 'encryption_key': return 'Per-tenant encryption key created';
      case 'storage_prefix': return 'Isolated storage prefix created';
      case 'default_settings': return 'Default settings seeded';
      case 'metering_ledger': return 'Usage metering opened';
      default: return stepKey;
    }
  }

  static nextAction(organization, provisioningComplete, readyToActivate) {
    if (organization.state === 'PROVISIONING') {
      return provisioningComplete ? 'Provisioning finished; advance the organization' : 'Run provisioning, or retry the step that failed';
    }
    if (organization.state === 'PENDING_AGREEMENT') {
      return readyToActivate ? 'Activate the organization' : 'Record and countersign the business associate agreement';
    }
    if (organization.state === 'ACTIVE') return null;
    return `No onboarding action while the organization is ${organization.state.toLowerCase()}`;
  }
}
