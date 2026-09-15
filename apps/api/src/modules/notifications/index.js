import { jobRegistry, jobQueue } from '../jobs/index.js';
import { env } from '../../config/env.js';
import { NotificationRegistry } from './notification.registry.js';
import { notificationRepository, roleMembershipReader } from './notification.repository.js';
import { RoleBasedAudienceResolver } from './audience-resolver.js';
import { LoggingChannelTransport, ChannelTransportRegistry } from './channel-transport.js';
import { ResendEmailTransport } from './resend-email-transport.js';
import { NotificationService, NOTIFICATION_DELIVERY_JOB } from './notification.service.js';
import { createNotificationDeliveryHandler } from './notification.delivery-handler.js';
import { createNotificationRouter } from './notification.routes.js';

export const notificationRegistry = new NotificationRegistry();
export const audienceResolver = new RoleBasedAudienceResolver(roleMembershipReader);

/**
 * Off-platform transports. Email uses the Resend transport when configured
 * (RESEND_API_KEY + RESEND_FROM_EMAIL); otherwise it falls back to the logging
 * adapter for local/dev without credentials. SMS remains the logging adapter.
 * Swapping the email adapter requires no change to any caller.
 */
const resendEmail = new ResendEmailTransport(env.resend);
export const channelTransports = new ChannelTransportRegistry(
  new Map([
    ['email', resendEmail.isConfigured() ? resendEmail : new LoggingChannelTransport('email', console)],
    ['sms', new LoggingChannelTransport('sms', console)],
  ]),
);

export const notificationService = new NotificationService({
  registry: notificationRegistry,
  repository: notificationRepository,
  audience: audienceResolver,
  jobQueue,
});

// Register the delivery job handler on the shared job registry (composition root).
jobRegistry.register({
  type: NOTIFICATION_DELIVERY_JOB,
  handler: createNotificationDeliveryHandler({ repository: notificationRepository, transports: channelTransports }),
  maxAttempts: 5,
});

export const notificationRouter = createNotificationRouter(notificationService);

export { NotificationService, NOTIFICATION_DELIVERY_JOB } from './notification.service.js';
export { NotificationRegistry } from './notification.registry.js';
export { resolveDeliveryChannels } from './notification.preferences.js';
export * from './notification.tokens.js';
