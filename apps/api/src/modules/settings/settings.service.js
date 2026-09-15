import { SettingsRegistry } from './settings.registry.js';

/**
 * Reads and writes tenant settings through the registry. The service owns no
 * value of its own: it resolves stored rows over registry defaults on read, and
 * validates every write against the registry before touching the repository.
 * The tenant id always comes from the verified principal.
 */
export class SettingsService {
  constructor(deps) {
    this.repository = deps.repository;
    this.registry = deps.registry ?? new SettingsRegistry();
  }

  async getEffectiveSettings(tenantId) {
    return this.registry.resolve(await this.repository.getSettings(tenantId));
  }

  async getNamespace(tenantId, namespace) {
    return this.registry.resolveNamespace(namespace, await this.repository.getSettings(tenantId));
  }

  async updateNamespace(tenantId, namespace, patch, actorId) {
    const entries = this.registry.validatePatch(namespace, patch);
    await this.repository.upsertSettings(tenantId, entries, actorId);
    return this.registry.resolveNamespace(namespace, await this.repository.getSettings(tenantId));
  }
}
