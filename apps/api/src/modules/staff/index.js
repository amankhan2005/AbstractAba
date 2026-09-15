import { organizationService } from '../organization/index.js';
import { notificationService, channelTransports } from '../notifications/index.js';
import { usersRepository } from '../users/index.js';
import { jobRegistry, jobQueue } from '../jobs/index.js';
import { env } from '../../config/env.js';
import { newId } from '../../utils/id.js';
import { hashPassword, generateTemporaryPassword } from '../../utils/password.js';
import { StaffService } from './staff.service.js';
import { staffRepository } from './staff.repository.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { PayRate } from '../../models/index.js';

/**
 * Pay-rate port (spec Module 1). The Staff form captures an Hourly Pay Rate in
 * whole dollars; this port persists it to the authoritative, effective-dated
 * PayRate model in MINOR units (cents) as an HOURLY rate. This is the SINGLE
 * source of pay truth — the same collection payroll reads (effectiveRate) — so
 * there is never a competing rate on a care-team assignment. A rate change
 * appends a new effective-dated row; history is preserved (never rewritten).
 */
const payRatesPort = {
  async setHourlyRate({ tenantId, staffProfileId, actorUserId, amount, effectiveFrom }) {
    const minor = Math.round(Number(amount) * 100);
    return withTenant(tenantId, async () => PayRate.create({
      staffProfileId,
      rateType: 'HOURLY',
      amount: minor,
      currency: 'usd',
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
      effectiveTo: null,
      createdBy: actorUserId ?? null,
      updatedBy: actorUserId ?? null,
    }));
  },
  async getCurrentHourlyRate({ tenantId, staffProfileId }) {
    return withTenant(tenantId, async () => {
      const now = new Date();
      const rates = await PayRate.find({ staffProfileId, rateType: 'HOURLY', effectiveFrom: { $lte: now } })
        .sort({ effectiveFrom: -1 }).lean();
      const active = rates.find((r) => !r.effectiveTo || new Date(r.effectiveTo) >= now);
      return active ? active.amount / 100 : null; // minor units -> dollars
    });
  },
};
import { createStaffRouter } from './staff.routes.js';
import { createStaffWelcomeEmailHandler, STAFF_WELCOME_EMAIL_JOB } from './staff-welcome.email.js';

/** The scheduled scan job type; a periodic trigger enqueues it per tenant. */
export const CREDENTIAL_SCAN_JOB = 'staff.credential_scan';
export { STAFF_WELCOME_EMAIL_JOB } from './staff-welcome.email.js';

/**
 * Composition root for the staff & credentials module. The service reads
 * organization state (ACTIVE gate), provisions the staff ACCOUNT through the
 * shared users repository (ACTIVE user + temporary password + membership +
 * role — no second auth/invitation system), delivers the welcome/login email
 * through the shared job queue + transport, and raises the credential-expiry
 * notification through the notifications port.
 */
export const staffService = new StaffService({
  repository: staffRepository,
  organizations: { getById: (id) => organizationService.getById(id) },
  usersRepository,
  passwords: { hash: hashPassword, generateTemporary: generateTemporaryPassword },
  payRates: payRatesPort,
  jobQueue,
  newId,
  notifications: { dispatch: (type, ctx) => notificationService.dispatch(type, ctx) },
});

// The welcome/login email handler — delivered through the shared transport. The
// temporary password travels only in the job payload → email, never logged.
jobRegistry.register({
  type: STAFF_WELCOME_EMAIL_JOB,
  handler: createStaffWelcomeEmailHandler({ transports: channelTransports, webAppUrl: env.webAppUrl }),
  maxAttempts: 5,
});

// The scan runs inside the job's tenant context (withTenant), so the handler
// simply delegates to the service for the active tenant.
jobRegistry.register({
  type: CREDENTIAL_SCAN_JOB,
  handler: async (_payload, { job }) => {
    if (!job.tenantId) return;
    await staffService.scanExpiringCredentials(job.tenantId);
  },
  maxAttempts: 3,
});

export const staffRouter = createStaffRouter(staffService);

/**
 * The authoritative hourly-rate reader/writer over the effective-dated PayRate
 * collection — the SAME rate the payroll run reads. Exported so other modules
 * (e.g. the BCBA session workflow's per-session payroll receipt) consume ONE
 * source of pay truth rather than re-deriving it.
 */
export const staffPayRatesPort = payRatesPort;

export { StaffService } from './staff.service.js';
export { StaffController } from './staff.controller.js';
export { staffRepository } from './staff.repository.js';
