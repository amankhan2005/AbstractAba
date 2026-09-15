import { CompanyInvitationService, COMPANY_INVITATION_DELIVERY_JOB } from './company-invitation.service.js';
import { createCompanyInvitationRouters, createCompanyInvitationDeliveryHandler } from './company-invitation.routes.js';
import { organizationService } from '../organization/index.js';
import { jobQueue } from '../jobs/index.js';
import { jobRegistry } from '../jobs/index.js';
import { channelTransports } from '../notifications/index.js';
import { env } from '../../config/env.js';
import { usersRepository } from '../users/index.js';
import { onboardingService } from '../onboarding/index.js';
import { authService } from '../auth/auth.service.js';

export const companyInvitationService = new CompanyInvitationService({
  organizationService,
  jobQueue,
  usersRepository,
  cloudinaryConfig: env.cloudinary,
  // Drives the existing provision → record agreement → countersign → activate
  // lifecycle and the post-onboarding auto-login session. No duplicate flow.
  onboardingService,
  authService,
});

// Register the delivery job on the shared registry (composition root), reusing
// the existing job worker + email transport — no separate email system.
jobRegistry.register({
  type: COMPANY_INVITATION_DELIVERY_JOB,
  handler: createCompanyInvitationDeliveryHandler({ transports: channelTransports, webAppUrl: env.webAppUrl }),
  maxAttempts: 5,
});

export const companyInvitationRouters = createCompanyInvitationRouters(companyInvitationService);
export { COMPANY_INVITATION_DELIVERY_JOB } from './company-invitation.service.js';
