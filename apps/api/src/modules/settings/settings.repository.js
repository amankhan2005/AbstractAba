import { OrganizationSetting } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { newId } from '../../utils/id.js';

/**
 * Persistence for organization settings (MongoDB/Mongoose). Settings are
 * tenant-owned; both operations run in the caller's tenant context and inherit
 * the tenant plugin's isolation on organization_setting. The port moves rows,
 * not meaning — the registry decides which rows are legitimate.
 */
export class SettingsRepository {
  async getSettings(tenantId) {
    return withTenant(tenantId, async () => {
      const rows = await OrganizationSetting.find({}).select({ namespace: 1, key: 1, value: 1 }).lean();
      return rows.map((r) => ({ namespace: r.namespace, key: r.key, value: r.value }));
    });
  }

  async upsertSettings(tenantId, entries, actorId) {
    await withTenant(tenantId, async () => {
      for (const e of entries) {
        await OrganizationSetting.updateOne(
          { namespace: e.namespace, key: e.key },
          { $set: { value: e.value, updatedBy: actorId }, $setOnInsert: { _id: newId(), createdBy: actorId } },
          { upsert: true },
        );
      }
    });
  }
}

export const settingsRepository = new SettingsRepository();
