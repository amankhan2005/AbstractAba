import { onboardingError } from './onboarding.errors.js';

/** The ordered steps every tenant passes through before it can be used. */
export const PROVISIONING_STEPS = ['encryption_key', 'storage_prefix', 'default_settings', 'metering_ledger'];

/** Local development provisioner — same shapes as the cloud one, allocates nothing chargeable. */
export class LocalResourceProvisioner {
  createEncryptionKey(organizationId) { return Promise.resolve(`local:key:${organizationId}`); }
  createStoragePrefix(organizationId) { return Promise.resolve(`tenants/${organizationId}/`); }
}

/**
 * Runs tenant provisioning. Every step is idempotent and recorded individually;
 * a completed step is skipped (re-running encryption_key would orphan a key). A
 * failure leaves the org in PROVISIONING and surfaces which step stopped — it
 * never advances a partially provisioned tenant. Ported from the original.
 */
export class ProvisioningService {
  constructor(deps) { this.deps = deps; }

  async run(organizationId) {
    for (const stepKey of PROVISIONING_STEPS) {
      await this.deps.repository.upsertProvisioningStep({ id: this.deps.newId(), organizationId, stepKey });
    }
    const existing = await this.deps.repository.listProvisioningSteps(organizationId);
    const completed = new Set(existing.filter((s) => s.state === 'COMPLETED').map((s) => s.stepKey));

    for (const stepKey of PROVISIONING_STEPS) {
      if (completed.has(stepKey)) continue;
      await this.deps.repository.markProvisioningStep({ organizationId, stepKey, state: 'RUNNING', detail: null, incrementAttempts: true });
      try {
        await this.execute(stepKey, organizationId);
        await this.deps.repository.markProvisioningStep({ organizationId, stepKey, state: 'COMPLETED', detail: null, incrementAttempts: false });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Step failed';
        await this.deps.repository.markProvisioningStep({ organizationId, stepKey, state: 'FAILED', detail, incrementAttempts: false });
        return { complete: false, steps: await this.deps.repository.listProvisioningSteps(organizationId), failedStep: stepKey };
      }
    }
    return { complete: true, steps: await this.deps.repository.listProvisioningSteps(organizationId), failedStep: null };
  }

  async execute(stepKey, organizationId) {
    switch (stepKey) {
      case 'encryption_key': {
        const kmsKeyArn = await this.deps.provisioner.createEncryptionKey(organizationId);
        await this.deps.repository.recordProvisionedResources({ organizationId, kmsKeyArn });
        return;
      }
      case 'storage_prefix': {
        const storagePrefix = await this.deps.provisioner.createStoragePrefix(organizationId);
        await this.deps.repository.recordProvisionedResources({ organizationId, storagePrefix });
        return;
      }
      case 'default_settings': {
        await this.deps.repository.seedDefaultSettings({
          organizationId,
          settings: this.deps.defaultSettings.map((s) => ({ id: this.deps.newId(), namespace: s.namespace, key: s.key, value: s.value })),
        });
        return;
      }
      case 'metering_ledger': {
        await this.deps.repository.openMeteringLedger({ id: this.deps.newId(), organizationId, idempotencyKey: `provisioned:${organizationId}` });
        return;
      }
      default:
        throw onboardingError('INTERNAL', { context: { reason: `unknown provisioning step: ${String(stepKey)}` } });
    }
  }
}
