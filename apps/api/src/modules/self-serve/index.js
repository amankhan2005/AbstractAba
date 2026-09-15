import { SelfServeService } from './selfServe.service.js';
import { createSelfServeRouter } from './selfServe.routes.js';
import { organizationService } from '../organization/index.js';
import { onboardingService } from '../onboarding/index.js';
import { usersService } from '../users/index.js';

/**
 * Composition root for public self-serve signup (BR-3). Pure orchestration over
 * existing services — no new model, no duplicated logic, agreement gate intact.
 */
export const selfServeService = new SelfServeService({
  organizations: organizationService,
  onboarding: onboardingService,
  users: usersService,
});

export const selfServeRouter = createSelfServeRouter(selfServeService);

export { SelfServeService } from './selfServe.service.js';
