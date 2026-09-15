import { ThemingService } from './theming.service.js';
import { preferenceRepository, brandingRepository } from './theming.repository.js';
import { createThemingRouters } from './theming.routes.js';
import { organizationService } from '../organization/index.js';

export const themingService = new ThemingService({
  preferences: preferenceRepository,
  branding: brandingRepository,
  organizations: {
    // Resolve the tenant's own company name (tradingName) server-side.
    getName: async (tenantId) => {
      const profile = await organizationService.getProfile(tenantId);
      return profile?.tradingName ?? null;
    },
  },
});
export const themingRouters = createThemingRouters(themingService);

export { ThemingService } from './theming.service.js';
export * from './design-tokens.js';
export * from './color.js';
