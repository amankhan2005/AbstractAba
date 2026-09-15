import {
  OrganizationAgreement,
  ProvisioningStep,
  OrganizationExport,
  Organization,
  OrganizationSetting,
  UsageEvent,
} from '../../models/index.js';
import { withPlatform, withTenant } from '../../tenancy/tenantContext.js';
import { PROVISIONING_STEPS } from './onboarding.provisioning.js';
import { onboardingError } from './onboarding.errors.js';

/**
 * Persistence for onboarding (MongoDB/Mongoose). Onboarding is a platform-
 * operator activity, so agreements, provisioning steps and exports (all keyed
 * by organizationId) are read/written under withPlatform(). The one exception
 * is seeding default settings: OrganizationSetting is tenant-owned (carries the
 * tenant plugin), so that write runs under withTenant(organizationId).
 */
export class OnboardingRepository {
  async createAgreement(input) {
    return withTenant(input.organizationId, async () => {
      const doc = await OrganizationAgreement.create({
        _id: input.id,
        organizationId: input.organizationId,
        type: input.type,
        version: input.version,
        executedByName: input.executedByName,
        executedByTitle: input.executedByTitle,
        executedAt: input.executedAt,
        executedIp: input.executedIp ?? null,
        documentRef: input.documentRef ?? null,
        createdBy: input.createdBy,
      });
      return toAgreement(doc.toObject());
    });
  }

  async findAgreements(organizationId) {
    return withTenant(organizationId, async () => {
      const docs = await OrganizationAgreement.find({ organizationId }).sort({ executedAt: -1 }).lean();
      return docs.map(toAgreement);
    });
  }

  async countersignAgreement(input) {
    return withPlatform(async () => {
      const updated = await OrganizationAgreement.findByIdAndUpdate(
        input.agreementId,
        { $set: { countersignedAt: new Date(), countersignedByUserId: input.userId } },
        { new: true },
      ).lean();
      if (!updated) throw onboardingError('NOT_FOUND');
      return toAgreement(updated);
    });
  }

  async attachAgreementToOrganization(input) {
    await withPlatform(() =>
      Organization.updateOne({ _id: input.organizationId }, { $set: { agreementId: input.agreementId } }),
    );
  }

  async listProvisioningSteps(organizationId) {
    return withTenant(organizationId, async () => {
      const docs = await ProvisioningStep.find({ organizationId }).lean();
      // Present in the canonical step order regardless of insertion order.
      return docs
        .map(toStep)
        .sort((a, b) => PROVISIONING_STEPS.indexOf(a.stepKey) - PROVISIONING_STEPS.indexOf(b.stepKey));
    });
  }

  async upsertProvisioningStep(input) {
    // The callback MUST be `async` (i.e. it must AWAIT the query inside the
    // context). A bare `() => ProvisioningStep.updateOne(...)` returns an
    // *unexecuted* Mongoose Query; withTenant()'s AsyncLocalStorage.run() then
    // returns before the query executes, popping the tenant scope. The query
    // executes later — outside the context — and the tenant plugin fails closed
    // ("Refused a tenant-scoped updateOne: no tenant context is active"). An
    // async callback awaits the query while the scope is still on the stack.
    await withTenant(input.organizationId, async () =>
      ProvisioningStep.updateOne(
        { organizationId: input.organizationId, stepKey: input.stepKey },
        { $setOnInsert: { _id: input.id, state: 'PENDING', attempts: 0 } },
        { upsert: true },
      ),
    );
  }

  async markProvisioningStep(input) {
    await withTenant(input.organizationId, async () =>
      ProvisioningStep.updateOne(
        { organizationId: input.organizationId, stepKey: input.stepKey },
        {
          $set: {
            state: input.state,
            detail: input.detail,
            ...(input.state === 'RUNNING' ? { startedAt: new Date() } : {}),
            ...(input.state === 'COMPLETED' ? { completedAt: new Date() } : {}),
          },
          ...(input.incrementAttempts ? { $inc: { attempts: 1 } } : {}),
        },
      ),
    );
  }

  async recordProvisionedResources(input) {
    const set = {};
    if (input.kmsKeyArn) set.kmsKeyArn = input.kmsKeyArn;
    if (input.storagePrefix) set.storagePrefix = input.storagePrefix;
    if (Object.keys(set).length === 0) return;
    await withPlatform(() => Organization.updateOne({ _id: input.organizationId }, { $set: set }));
  }

  async seedDefaultSettings(input) {
    // OrganizationSetting is tenant-owned; seed under the tenant's context.
    return withTenant(input.organizationId, async () => {
      let count = 0;
      for (const s of input.settings) {
        const res = await OrganizationSetting.updateOne(
          { namespace: s.namespace, key: s.key },
          { $setOnInsert: { _id: s.id, value: s.value } },
          { upsert: true },
        );
        if (res.upsertedCount) count += 1;
      }
      return count;
    });
  }

  async openMeteringLedger(input) {
    await withPlatform(() =>
      UsageEvent.updateOne(
        { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey },
        { $setOnInsert: { _id: input.id, metricKey: 'provisioned', quantity: 0, occurredAt: new Date() } },
        { upsert: true },
      ),
    );
  }

  async createExport(input) {
    return withTenant(input.organizationId, async () => {
      const doc = await OrganizationExport.create({
        _id: input.id,
        organizationId: input.organizationId,
        requestedByUserId: input.requestedByUserId,
        state: 'REQUESTED',
        requestedAt: new Date(),
      });
      return toExport(doc.toObject());
    });
  }

  async updateExportState(input) {
    return withPlatform(async () => {
      const set = { state: input.state };
      if (input.artifactRef !== undefined) set.artifactRef = input.artifactRef;
      if (input.expiresAt !== undefined) set.expiresAt = input.expiresAt;
      if (input.failure !== undefined) set.failure = input.failure;
      if (input.state === 'AVAILABLE') set.availableAt = new Date();
      if (input.state === 'DOWNLOADED') set.downloadedAt = new Date();
      const updated = await OrganizationExport.findByIdAndUpdate(input.exportId, { $set: set }, { new: true }).lean();
      if (!updated) throw onboardingError('NOT_FOUND');
      return toExport(updated);
    });
  }

  async findLatestExport(organizationId) {
    return withTenant(organizationId, async () => {
      const doc = await OrganizationExport.findOne({ organizationId }).sort({ requestedAt: -1 }).lean();
      return doc ? toExport(doc) : null;
    });
  }
}

function toAgreement(doc) {
  return {
    id: doc._id,
    organizationId: doc.organizationId,
    type: doc.type,
    version: doc.version,
    executedByName: doc.executedByName,
    executedByTitle: doc.executedByTitle,
    executedAt: doc.executedAt,
    countersignedAt: doc.countersignedAt ?? null,
    countersignedByUserId: doc.countersignedByUserId ?? null,
    documentRef: doc.documentRef ?? null,
  };
}

function toStep(doc) {
  return {
    id: doc._id,
    organizationId: doc.organizationId,
    stepKey: doc.stepKey,
    state: doc.state,
    attempts: doc.attempts ?? 0,
    detail: doc.detail ?? null,
    completedAt: doc.completedAt ?? null,
  };
}

function toExport(doc) {
  return {
    id: doc._id,
    organizationId: doc.organizationId,
    state: doc.state,
    requestedByUserId: doc.requestedByUserId,
    requestedAt: doc.requestedAt,
    artifactRef: doc.artifactRef ?? null,
    availableAt: doc.availableAt ?? null,
    downloadedAt: doc.downloadedAt ?? null,
    expiresAt: doc.expiresAt ?? null,
    failure: doc.failure ?? null,
  };
}

export const onboardingRepository = new OnboardingRepository();
