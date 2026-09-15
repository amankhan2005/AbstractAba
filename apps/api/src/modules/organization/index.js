import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { newId } from '../../utils/id.js';
import { OrganizationService } from './organization.service.js';
import { organizationRepository } from './organization.repository.js';
import { createOrganizationRouters } from './organization.routes.js';

/**
 * Platform defaults for the organization module. The grace window between
 * offboarding and destruction is overridable per organization; the default
 * branding is what an unknown host receives so customers cannot be enumerated.
 */
export const DESTRUCTION_GRACE_DAYS = 30;
export const DEFAULT_BRANDING = Object.freeze({
  tradingName: PLATFORM_BRAND.productName,
  logoUrl: null,
  accent: PLATFORM_BRAND.colors.primary,
});

export const organizationService = new OrganizationService({
  repository: organizationRepository,
  newId,
  destructionGraceDays: DESTRUCTION_GRACE_DAYS,
  defaultBranding: DEFAULT_BRANDING,
});

export const organizationRouters = createOrganizationRouters(organizationService);

export { OrganizationService } from './organization.service.js';
export { OrganizationController } from './organization.controller.js';
export { organizationRepository } from './organization.repository.js';
export * from './organization.state-machine.js';
export * from './organization.slug.js';
