import { InquiryService, INQUIRY_NOTIFY_TEAM_JOB, INQUIRY_CONFIRM_SUBMITTER_JOB } from './inquiry.service.js';
import { InquiryRepository } from './inquiry.repository.js';
import { createInquiryRouters, createInquirySubmitRateLimit } from './inquiry.routes.js';
import { createInquiryTeamNotificationHandler, createInquiryConfirmationHandler } from './inquiry.email.js';
import { jobQueue, jobRegistry } from '../jobs/index.js';
import { channelTransports } from '../notifications/index.js';
import { auditService } from '../audit/audit.service.js';
import { env } from '../../config/env.js';

export const inquiryService = new InquiryService({
  repository: new InquiryRepository(),
  jobQueue,
  audit: auditService,
});

// Both deliveries run on the shared job worker and channel transport.
jobRegistry.register({
  type: INQUIRY_NOTIFY_TEAM_JOB,
  handler: createInquiryTeamNotificationHandler({
    transports: channelTransports,
    notifyEmail: env.inquiries.notifyEmail,
    consoleUrl: env.inquiries.consoleUrl,
  }),
  maxAttempts: 5,
});
jobRegistry.register({
  type: INQUIRY_CONFIRM_SUBMITTER_JOB,
  handler: createInquiryConfirmationHandler({ transports: channelTransports }),
  maxAttempts: 5,
});

export const inquiryRouters = createInquiryRouters(inquiryService, {
  submitLimiter: createInquirySubmitRateLimit({ max: env.inquiries.rateLimitMax }),
});

export { InquiryService } from './inquiry.service.js';
