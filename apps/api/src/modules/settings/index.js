import { SettingsRegistry } from './settings.registry.js';
import { SettingsService } from './settings.service.js';
import { settingsRepository } from './settings.repository.js';
import { createSettingsRouter } from './settings.routes.js';

/** Shared registry instance (also the source of the provisioning default seed). */
export const settingsRegistry = new SettingsRegistry();

export const settingsService = new SettingsService({ repository: settingsRepository, registry: settingsRegistry });
export const settingsRouter = createSettingsRouter(settingsService);

export { SettingsRegistry } from './settings.registry.js';
export { SETTINGS_CATALOGUE } from './settings.catalogue.js';
