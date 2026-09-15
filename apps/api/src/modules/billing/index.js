import { BillingService } from './billing.service.js';
import { createBillingRouters } from './billing.routes.js';
import { jobRegistry, jobQueue } from '../jobs/index.js';
import { channelTransports } from '../notifications/index.js';

/**
 * Billing composition root. Abstract ABA uses MANUAL billing — there is no payment
 * processor, no Stripe, no webhooks. Payments are recorded by authorized users.
 */
export const billingService = new BillingService({ jobQueue });

// Notification job for billing events — reuses the shared worker + email
// transport. No PHI, no amounts, no secrets in the payload.
jobRegistry.register({
  type: 'billing.notify',
  handler: async (job) => {
    const { event, organizationId } = job.payload ?? {};
    if (!channelTransports?.has?.('email')) return; // logging fallback in dev
    const transport = channelTransports.get('email');
    await transport.send({
      recipientUserId: null,
      recipientEmail: null,
      view: { subject: `Billing update: ${event}`, link: null, body: `A billing event (${event}) occurred for organization ${organizationId}.` },
    }).catch(() => {});
  },
  maxAttempts: 3,
});

export const billingRouters = createBillingRouters(billingService);
export { BillingService } from './billing.service.js';
