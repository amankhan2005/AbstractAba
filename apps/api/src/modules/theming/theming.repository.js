import { UserPreference, OrganizationSetting } from '../../models/index.js';
import { withPlatform, withTenant } from '../../tenancy/tenantContext.js';
import { newId } from '../../utils/id.js';

/**
 * Preference repository — platform-scoped: a person's preferences follow them
 * across organizations, so reads/writes run outside tenant context. Stores only
 * the keys the user has set; defaults and fall-through are the service's job.
 */
export class PreferenceRepository {
  async getPreferences(userId) {
    return withPlatform(async () => {
      const row = await UserPreference.findById(userId).select({ preferences: 1 }).lean();
      return row?.preferences ?? {};
    });
  }
  async savePreferences(userId, preferences) {
    await withPlatform(() =>
      UserPreference.updateOne(
        { _id: userId },
        { $set: { preferences } },
        { upsert: true },
      ),
    );
  }
}

const NAMESPACE = 'branding';
const BRAND_KEYS = ['primary', 'secondary', 'logoUrl'];

/**
 * Branding repository — brand tokens are tenant settings, stored in
 * organization_setting under the `branding` namespace, inheriting the tenant
 * plugin's isolation. Only the hue and logo are persisted; ramps and accessible
 * foregrounds are derived at resolution.
 */
export class BrandingRepository {
  async getBrandTokens(tenantId) {
    return withTenant(tenantId, async () => {
      const rows = await OrganizationSetting.find({ namespace: NAMESPACE, key: { $in: BRAND_KEYS } })
        .select({ key: 1, value: 1 }).lean();
      const patch = {};
      for (const row of rows) {
        if (row.key === 'primary' && typeof row.value === 'string') patch.primary = row.value;
        else if (row.key === 'secondary' && typeof row.value === 'string') patch.secondary = row.value;
        else if (row.key === 'logoUrl') patch.logoUrl = typeof row.value === 'string' ? row.value : null;
      }
      return patch;
    });
  }
  async saveBrandTokens(tenantId, tokens, actorId) {
    const entries = Object.entries(tokens);
    if (entries.length === 0) return;
    await withTenant(tenantId, async () => {
      for (const [key, value] of entries) {
        await OrganizationSetting.updateOne(
          { namespace: NAMESPACE, key },
          { $set: { value, updatedBy: actorId }, $setOnInsert: { _id: newId(), createdBy: actorId } },
          { upsert: true },
        );
      }
    });
  }
}

export const preferenceRepository = new PreferenceRepository();
export const brandingRepository = new BrandingRepository();
