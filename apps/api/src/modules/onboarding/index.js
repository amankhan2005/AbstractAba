import { newId } from '../../utils/id.js';
import { organizationService, DESTRUCTION_GRACE_DAYS } from '../organization/index.js';
import { onboardingRepository } from './onboarding.repository.js';
import { ProvisioningService, LocalResourceProvisioner } from './onboarding.provisioning.js';
import { OnboardingService } from './onboarding.service.js';
import { createOnboardingRouter } from './onboarding.routes.js';

/** How long a tenant export stays downloadable. */
export const EXPORT_TTL_HOURS = 72;

/** Seeded into every new organization during provisioning (semantic colours are not among them). */
// Matches the settings catalogue (security namespace) so the registry default
// and the value seeded at provisioning agree — the original's stated invariant.
export const DEFAULT_SETTINGS = [
  { namespace: 'security', key: 'sessionIdleTimeoutMinutes', value: 15 },
  { namespace: 'security', key: 'mfaRequiredForPrivilegedRoles', value: true },
];

export const provisioningService = new ProvisioningService({
  repository: onboardingRepository,
  provisioner: new LocalResourceProvisioner(),
  newId,
  defaultSettings: DEFAULT_SETTINGS,
});

export const onboardingService = new OnboardingService({
  repository: onboardingRepository,
  provisioning: provisioningService,
  organizations: organizationService,
  newId,
  destructionGraceDays: DESTRUCTION_GRACE_DAYS,
  exportTtlHours: EXPORT_TTL_HOURS,
});

export const onboardingRouter = createOnboardingRouter(onboardingService);

export { OnboardingService } from './onboarding.service.js';
export { ProvisioningService, LocalResourceProvisioner, PROVISIONING_STEPS } from './onboarding.provisioning.js';
